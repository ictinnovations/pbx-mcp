/**
 * Provisioning: validation, allowlists, namespacing, safety behaviour and tool
 * registration. Everything runs against an in-process mock AMI on loopback.
 *
 * Runs against the build output, so `npm run build` first (`npm test` does both).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { AmiClient } from "../dist/ami.js";
import { Provisioner, assertSafeValue, assertTrunkAllowed, updateConfigFields } from "../dist/provision.js";
import { startMockAmi } from "./helpers/mock-ami.mjs";

const FILE = "pjsip_mcp.conf";
const OPTS = { file: FILE, trunkAllow: ["192.0.2.0/24", "sip.example.net"], contextAllow: ["mcp-test"] };
const trunk = (o = {}) => ({ name: "carrier1", host: "192.0.2.10", context: "mcp-test", ...o });
const ext = (o = {}) => ({ number: "1001", context: "mcp-test", ...o });

/** Variables of the section with this name and type. */
const section = (mock, name, type) =>
  mock.categories.find((c) => c.name === name && c.vars.some(([k, v]) => k === "type" && v === type))?.vars;
const sectionNames = (mock) => mock.categories.map((c) => c.name);

const mocks = [];
async function setup(seed, opts = OPTS) {
  const mock = await startMockAmi(seed);
  mocks.push(mock);
  const clients = [];
  const getClient = async () => {
    const c = new AmiClient({ host: "127.0.0.1", port: mock.port, username: "mcp", password: "x", timeoutMs: 3000 });
    await c.connect();
    clients.push(c);
    return c;
  };
  const prov = new Provisioner(getClient, opts);
  mock.dispose = () => clients.forEach((c) => c.close());
  return { mock, prov };
}
after(async () => {
  for (const m of mocks) {
    m.dispose?.();
    await m.close();
  }
});

// --- UpdateConfig formatting ---

test("UpdateConfig uses numbered headers and the managed file for both Src and Dst", () => {
  const f = updateConfigFields(FILE, [
    { action: "newcat", cat: "mcp-a" },
    { action: "append", cat: "mcp-a", var: "type", value: "aor" },
    { action: "delcat", cat: "mcp-b" },
  ]);
  assert.deepEqual(f, {
    Action: "UpdateConfig",
    SrcFilename: FILE,
    DstFilename: FILE,
    "Action-000000": "newcat",
    "Cat-000000": "mcp-a",
    "Action-000001": "append",
    "Cat-000001": "mcp-a",
    "Var-000001": "type",
    "Value-000001": "aor",
    "Action-000002": "delcat",
    "Cat-000002": "mcp-b",
  });
});

test("every value is checked: ';', '#', '=', newlines and leading whitespace are refused", () => {
  for (const bad of ["a;b", "a#b", "a=b", "a\nAction: Logoff", "a\rb", " lead"]) {
    assert.throws(() => assertSafeValue("x", bad), undefined, JSON.stringify(bad));
    assert.throws(() => updateConfigFields(FILE, [{ action: "append", cat: "mcp-a", var: "v", value: bad }]));
  }
  assert.doesNotThrow(() => assertSafeValue("x", "sip:192.0.2.1:5060"));
});

// --- validation ---

test("trunk and extension inputs: each invalid field is rejected before any AMI traffic", async () => {
  const { mock, prov } = await setup();
  const badTrunks = [
    { name: "has space" },
    { name: "semi;colon" },
    { name: "" },
    { name: "x".repeat(33) },
    { name: "a\nAction: Logoff" },
    { host: "192.0.2.10;evil" },
    { host: "192.0.2.10=1" },
    { host: "#192.0.2.10" },
    { host: " 192.0.2.10" },
    { host: "[2001:db8::1]" },
    { port: 0 },
    { port: 65536 },
    { port: 5060.5 },
    { transport: "ws" },
    { codecs: ["gsm"] },
    { codecs: [] },
    { context: "mcp-test;x" },
    { context: "mcp test" },
  ];
  for (const bad of badTrunks) await assert.rejects(prov.createTrunk(trunk(bad)), undefined, JSON.stringify(bad));
  for (const bad of [{ number: "10 01" }, { number: "1001#" }, { context: "a=b" }, { codecs: ["speex"] }]) {
    await assert.rejects(prov.createExtension(ext(bad)), undefined, JSON.stringify(bad));
  }
  await assert.rejects(prov.deleteTrunk({ name: "../x" }));
  await assert.rejects(prov.deleteExtension({ number: "1 2" }));
  assert.equal(mock.received.length, 0, "validation must fail before connecting");
});

test("the managed file can never be pjsip.conf or a path", () => {
  for (const file of ["pjsip.conf", "PJSIP.CONF", "../pjsip.conf", "sub/x.conf", "x.txt", "manager.conf", "extensions.conf", "pjsip_.conf"]) {
    assert.throws(() => new Provisioner(async () => null, { ...OPTS, file }), /bare pjsip_\*\.conf/, file);
  }
  assert.doesNotThrow(() => new Provisioner(async () => null, { ...OPTS, file: "pjsip_lab.conf" }));
});

test("a malformed PBX_MCP_TRUNK_ALLOW entry fails at startup, even behind a matching entry", () => {
  for (const bad of ["192.0.2.0/33", "192.0.2.0/", "192.0.2.256/24"]) {
    assert.throws(
      () => new Provisioner(async () => null, { ...OPTS, trunkAllow: ["192.0.2.0/24", bad] }),
      /PBX_MCP_TRUNK_ALLOW entry .* is not a valid IPv4 CIDR/,
      bad
    );
  }
});

// --- allowlists ---

test("trunk create is refused when PBX_MCP_TRUNK_ALLOW is empty (fail closed)", async () => {
  const { mock, prov } = await setup(undefined, { ...OPTS, trunkAllow: [] });
  await assert.rejects(prov.createTrunk(trunk()), /PBX_MCP_TRUNK_ALLOW is not set/);
  await assert.rejects(prov.createTrunk(trunk({ dry_run: true })), /PBX_MCP_TRUNK_ALLOW is not set/);
  assert.equal(mock.received.length, 0);
});

test("trunk allowlist: CIDR membership, bare IPs, literal hostnames, no DNS", async () => {
  const { prov } = await setup(undefined, {
    ...OPTS,
    trunkAllow: ["192.0.2.0/25", "198.51.100.7", "sip.example.net"],
  });
  const ok = (host) => prov.createTrunk(trunk({ host, dry_run: true }));
  await ok("192.0.2.127");
  await ok("198.51.100.7");
  await ok("SIP.Example.Net");
  for (const host of ["192.0.2.128", "198.51.100.8", "203.0.113.1", "other.example.net", "sip.example.net.evil.test"]) {
    await assert.rejects(ok(host), /not on the PBX_MCP_TRUNK_ALLOW list/, host);
  }
});

test("a malformed allowlist entry refuses rather than silently allowing", () => {
  assert.throws(() => assertTrunkAllowed("192.0.2.10", ["192.0.2.0/99"]), /not a valid IPv4 CIDR/);
});

test("context allowlist: unset refuses everything, others are rejected", async () => {
  const { prov } = await setup(undefined, { ...OPTS, contextAllow: [] });
  await assert.rejects(prov.createExtension(ext()), /PBX_MCP_CONTEXT_ALLOW/);
  await assert.rejects(prov.createTrunk(trunk()), /PBX_MCP_CONTEXT_ALLOW/);
  const { prov: p2, mock } = await setup();
  await assert.rejects(p2.createExtension(ext({ context: "from-internal" })), /PBX_MCP_CONTEXT_ALLOW/);
  assert.equal(mock.received.length, 0);
});

// --- create, verify, secrets ---

test("trunk create writes three mcp- sections to the managed file only, then reloads and verifies", async () => {
  const { mock, prov } = await setup();
  const r = await prov.createTrunk(trunk({ port: 5070, transport: "tcp", codecs: ["ulaw", "g722"] }));
  // Endpoint, aor and identify share one name; each holds only its own variables.
  assert.deepEqual(sectionNames(mock), ["mcp-carrier1", "mcp-carrier1", "mcp-carrier1"]);
  assert.deepEqual(section(mock, "mcp-carrier1", "endpoint"), [
    ["type", "endpoint"],
    ["transport", "transport-tcp"],
    ["context", "mcp-test"],
    ["disallow", "all"],
    ["allow", "ulaw,g722"],
    ["aors", "mcp-carrier1"],
  ]);
  assert.deepEqual(section(mock, "mcp-carrier1", "aor"), [["type", "aor"], ["contact", "sip:192.0.2.10:5070"]]);
  assert.deepEqual(section(mock, "mcp-carrier1", "identify"), [
    ["type", "identify"],
    ["endpoint", "mcp-carrier1"],
    ["match", "192.0.2.10"],
  ]);
  for (const a of mock.actions("UpdateConfig").concat(mock.actions("GetConfig"))) {
    assert.ok([a.SrcFilename, a.DstFilename, a.Filename].every((x) => x === undefined || x === FILE));
  }
  const cmds = mock.actions("Command").map((c) => c.Command);
  assert.deepEqual(cmds, ["module reload res_pjsip.so", "pjsip show endpoint mcp-carrier1"]);
  assert.match(r.verified, /Endpoint:\s+mcp-carrier1/);
  assert.match(r.config, /\[mcp-carrier1\]\ntype=identify\nendpoint=mcp-carrier1\nmatch=192\.0\.2\.10/);
});

test("extension create: strong one-time password, stored only in the auth section", async () => {
  const { mock, prov } = await setup();
  const a = await prov.createExtension(ext());
  const b = await prov.createExtension(ext({ number: "1002" }));
  assert.ok(a.password.length >= 20 && /^[A-Za-z0-9_-]+$/.test(a.password));
  assert.notEqual(a.password, b.password);
  assert.deepEqual(section(mock, "mcp-1001", "auth"), [
    ["type", "auth"],
    ["auth_type", "userpass"],
    ["username", "mcp-1001"],
    ["password", a.password],
  ]);
  assert.deepEqual(section(mock, "mcp-1001", "aor"), [["type", "aor"], ["max_contacts", "1"], ["remove_existing", "yes"]]);
  assert.ok(!a.config.includes(a.password) && !a.verified.includes(a.password));
  assert.match(a.config, /password=<generated on create>/);
});

test("name collision fails and leaves the file untouched", async () => {
  const { mock, prov } = await setup();
  await prov.createTrunk(trunk());
  const before = JSON.stringify([...mock.categories]);
  const updates = mock.actions("UpdateConfig").length;
  await assert.rejects(prov.createTrunk(trunk({ host: "192.0.2.99" })), /already exists.*refusing to overwrite/);
  assert.equal(JSON.stringify([...mock.categories]), before);
  assert.equal(mock.actions("UpdateConfig").length, updates, "no second UpdateConfig was attempted");
});

test("dry_run returns the exact block and makes no AMI calls at all", async () => {
  let connected = 0;
  const prov = new Provisioner(async () => { connected++; throw new Error("must not connect"); }, OPTS);
  const t = await prov.createTrunk(trunk({ dry_run: true }));
  const e = await prov.createExtension(ext({ dry_run: true }));
  assert.equal(connected, 0);
  assert.equal(
    t.config,
    [
      "[mcp-carrier1]", "type=endpoint", "transport=transport-udp", "context=mcp-test", "disallow=all",
      "allow=ulaw,alaw", "aors=mcp-carrier1", "",
      "[mcp-carrier1]", "type=aor", "contact=sip:192.0.2.10:5060", "",
      "[mcp-carrier1]", "type=identify", "endpoint=mcp-carrier1", "match=192.0.2.10",
    ].join("\n")
  );
  assert.equal(e.password, undefined);
  assert.match(e.config, /\[mcp-1001\]\ntype=auth\nauth_type=userpass\nusername=mcp-1001/);
});

test("failed verification rolls back with DelCat and reports an error without the password", async () => {
  const { mock, prov } = await setup();
  mock.failVerify = true;
  let message = "";
  await prov.createExtension(ext()).catch((e) => { message = e.message; });
  assert.match(message, /Verification failed.*Rolled back/s);
  assert.match(message, /#include pjsip_mcp\.conf.*pjsip\.conf/s, "points at the include line");
  assert.equal(mock.categories.length, 0, "rollback removed every section");
  const dels = mock.actions("UpdateConfig").filter((u) => Object.values(u).includes("delcat"));
  assert.equal(dels.length, 1);
  const create = mock.actions("UpdateConfig")[0];
  const key = Object.keys(create).find((k) => create[k] === "password");
  const pw = create[key.replace("Var", "Value")];
  assert.ok(pw && !message.includes(pw), "error text must not contain the generated password");
});

// --- list / delete ---

const foreign = [
  { name: "ext9", vars: [["type", "endpoint"]] },
  { name: "ext9", vars: [["type", "auth"]] }, // a complete-looking object outside the namespace
  { name: "general-thing", vars: [["type", "endpoint"]] },
  { name: "other", vars: [["type", "endpoint"], ["context", "default"]] },
  { name: "other-auth", vars: [["type", "auth"]] },
];

test("list and delete only ever see mcp- sections", async () => {
  const { mock, prov } = await setup(foreign);
  await prov.createTrunk(trunk());
  await prov.createExtension(ext());
  const listed = await prov.list();
  assert.deepEqual(listed.map((o) => `${o.kind}:${o.name}`).sort(), ["extension:1001", "trunk:carrier1"], "ext9 is not ours");
  await assert.rejects(prov.deleteExtension({ number: "ext9" }), /No managed extension/);
  assert.ok(!JSON.stringify(listed).includes("password"));

  // "other" has no mcp- prefix, so naming it must not reach it.
  await assert.rejects(prov.deleteExtension({ number: "other" }), /No managed extension/);
  await assert.rejects(prov.deleteTrunk({ name: "other" }), /No managed trunk/);
  // An extension is not deletable as a trunk, and vice versa.
  await assert.rejects(prov.deleteTrunk({ name: "1001" }), /No managed trunk/);
  await assert.rejects(prov.deleteExtension({ number: "carrier1" }), /No managed extension/);

  await prov.deleteTrunk({ name: "carrier1" });
  await prov.deleteExtension({ number: "1001" });
  assert.deepEqual(sectionNames(mock), foreign.map((c) => c.name), "foreign sections untouched");
  const delOpts = mock.actions("UpdateConfig").flatMap((u) => Object.entries(u).filter(([k]) => k.startsWith("Options-")).map(([, v]) => v));
  assert.ok(delOpts.length >= 6 && delOpts.every((o) => /^catfilter="type=\^\w+\$"$/.test(o)), "every DelCat is narrowed by type");
  const delNames = mock.actions("UpdateConfig").flatMap((u) => Object.entries(u).filter(([k]) => k.startsWith("Cat-")).map(([, v]) => v));
  assert.ok(delNames.every((n) => n.startsWith("mcp-")));
});

test("after create+delete the managed file is empty again", async () => {
  const { mock, prov } = await setup();
  await prov.createTrunk(trunk());
  await prov.createExtension(ext());
  await prov.deleteTrunk({ name: "carrier1" });
  await prov.deleteExtension({ number: "1001" });
  assert.equal(mock.categories.length, 0);
});

test("a create that times out after Asterisk applied it is rolled back", async () => {
  const { mock, prov } = await setup();
  mock.swallowNext = "UpdateConfig";
  await assert.rejects(prov.createTrunk(trunk()), /timed out.*may have been applied.*Rolled back/s);
  assert.equal(mock.categories.length, 0);
  await prov.createTrunk(trunk()); // and a retry is not blocked by an orphan
});

test("a create that times out with nothing written says there is nothing to roll back", async () => {
  const { mock, prov } = await setup();
  mock.dropNext = "UpdateConfig";
  await assert.rejects(prov.createTrunk(trunk()), (e) => {
    assert.match(e.message, /timed out.*Nothing to roll back/s);
    assert.doesNotMatch(e.message, /Rollback FAILED/);
    return true;
  });
  assert.equal(mock.categories.length, 0);
});

test("a trunk and an extension cannot share a name", async () => {
  const { prov } = await setup();
  await prov.createTrunk(trunk({ name: "1001" }));
  await assert.rejects(prov.createExtension(ext()), /already exists/);
});

test("a rejected operation does not wedge the serialization chain", async () => {
  const { mock, prov } = await setup();
  await prov.createExtension(ext());
  const results = await Promise.allSettled([prov.createExtension(ext()), prov.createExtension(ext({ number: "1002" }))]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.ok(sectionNames(mock).includes("mcp-1002"));
});

test("IP-looking hosts that are not canonical IPv4 do not pass an IP-only allowlist", async () => {
  const { prov } = await setup(undefined, { ...OPTS, trunkAllow: ["192.0.2.0/24"] });
  for (const host of ["0192.0.2.1", "3221225985", "192.0.2", "192.0.2.256"]) {
    await assert.rejects(prov.createTrunk(trunk({ host, dry_run: true })), /not on the PBX_MCP_TRUNK_ALLOW list/, host);
  }
});

// --- serialization ---

test("concurrent creates are serialized: read-modify-write never interleaves", async () => {
  const { mock, prov } = await setup();
  mock.delayMs = 15;
  await Promise.all([prov.createTrunk(trunk({ name: "a" })), prov.createTrunk(trunk({ name: "b" })), prov.createExtension(ext())]);
  const seq = mock.actions().map((r) => r.Action + (r.Command ? ":" + r.Command.split(" ")[0] : ""));
  const unit = ["GetConfig", "UpdateConfig", "Command:module", "Command:pjsip"];
  assert.deepEqual(seq, [...unit, ...unit, ...unit]);
});

// --- MCP surface (real server process, mock AMI) ---

const here = path.dirname(fileURLToPath(import.meta.url));
async function withServer(extraEnv, fn, seed) {
  const mock = await startMockAmi(seed);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "..", "dist", "index.js")],
    env: { PATH: process.env.PATH, ASTERISK_AMI_HOST: "127.0.0.1", ASTERISK_AMI_PORT: String(mock.port), ASTERISK_AMI_USERNAME: "mcp", ASTERISK_AMI_PASSWORD: "x", ...extraEnv },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (d) => (stderr += d));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    await fn(client, mock, () => stderr);
  } finally {
    await client.close();
    await mock.close();
  }
}
const names = async (c) => (await c.listTools()).tools.map((t) => t.name);

test("provisioning tools are absent unless PBX_MCP_ALLOW_PROVISION is set", async () => {
  await withServer({}, async (c) => {
    assert.ok(!(await names(c)).some((n) => /_(trunk|extension)_/.test(n)));
  });
  await withServer({ PBX_MCP_ALLOW_WRITE: "true" }, async (c) => {
    const n = await names(c);
    assert.ok(n.includes("asterisk_originate") && !n.some((x) => /_(trunk|extension)_/.test(x)), "write flag alone does not enable provisioning");
  });
});

test("provisioning tools appear with the flag, independent of PBX_MCP_ALLOW_WRITE", async () => {
  await withServer({ PBX_MCP_ALLOW_PROVISION: "true" }, async (c) => {
    const n = await names(c);
    for (const t of ["trunk_create", "trunk_list", "trunk_delete", "extension_create", "extension_list", "extension_delete"]) {
      assert.ok(n.includes(`asterisk_${t}`), t);
    }
    assert.ok(!n.includes("asterisk_originate"));
  });
});

test("tool call: password returned once, never written to stderr, list never shows it", async () => {
  const env = { PBX_MCP_ALLOW_PROVISION: "true", PBX_MCP_CONTEXT_ALLOW: "mcp-test", PBX_MCP_TRUNK_ALLOW: "192.0.2.0/24" };
  await withServer(env, async (c, mock, stderr) => {
    const created = await c.callTool({ name: "asterisk_extension_create", arguments: { number: "2001", context: "mcp-test" } });
    const body = created.content[0].text;
    const pw = /Password: (\S+)/.exec(body)[1];
    assert.ok(pw.length >= 20);
    assert.match(body, /SIP username: mcp-2001/);
    const listed = (await c.callTool({ name: "asterisk_extension_list", arguments: {} })).content[0].text;
    assert.match(listed, /2001/);
    assert.ok(!listed.includes(pw) && !stderr().includes(pw));
    const bad = await c.callTool({ name: "asterisk_trunk_create", arguments: { name: "t", host: "203.0.113.5", context: "mcp-test" } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /TRUNK_ALLOW/);
    const badInput = await c.callTool({ name: "asterisk_trunk_create", arguments: { name: "t;x", host: "192.0.2.1", context: "mcp-test" } });
    assert.equal(badInput.isError, true);
  });
});

test("tool output goes through the 20,000-character clamp", async () => {
  const seed = [];
  for (let i = 0; i < 400; i++) {
    const name = `mcp-trunk-number-${String(i).padStart(4, "0")}`;
    seed.push({ name, vars: [["type", "endpoint"], ["context", "mcp-test"], ["allow", "ulaw,alaw,g722"]] });
    seed.push({ name, vars: [["type", "aor"], ["contact", "sip:192.0.2.10:5060"]] });
    seed.push({ name, vars: [["type", "identify"], ["match", "192.0.2.10"]] });
  }
  await withServer({ PBX_MCP_ALLOW_PROVISION: "true" }, async (c) => {
    const out = (await c.callTool({ name: "asterisk_trunk_list", arguments: {} })).content[0].text;
    assert.match(out, /\[truncated \d+ more characters\]$/);
    assert.ok(out.length < 20100);
  }, seed);
});
