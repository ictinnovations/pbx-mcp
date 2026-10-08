/**
 * Integration tests against a real Asterisk. Opt-in: set PBX_MCP_IT=1.
 *
 *   ASTERISK_AMI_HOST / ASTERISK_AMI_PORT / ASTERISK_AMI_USERNAME / ASTERISK_AMI_PASSWORD
 *   PBX_MCP_IT_SIP_PORT     SIP port of that Asterisk (default 5060)
 *   PBX_MCP_IT_CONTAINER    optional: Docker container name; when set, the managed
 *                           file is also read from inside it with `docker exec`
 *                           (honours DOCKER_HOST) from /etc/asterisk/${PBX_MCP_PJSIP_FILE}
 *
 * The Asterisk needs the one-time `#include pjsip_mcp.conf` line, a udp transport
 * named transport-udp, and a dialplan context called mcp-test. Everything the
 * tests create is removed again, also on failure.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dgram from "node:dgram";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AmiClient } from "../dist/ami.js";
import { Provisioner } from "../dist/provision.js";

const skip = process.env.PBX_MCP_IT !== "1" && "set PBX_MCP_IT=1 to run against a live Asterisk";
const env = process.env;
const FILE = env.PBX_MCP_PJSIP_FILE || "pjsip_mcp.conf";
const OPTS = { file: FILE, trunkAllow: ["192.0.2.0/24"], contextAllow: ["mcp-test"] };

const created = { trunks: [], exts: [] };
let client;
const getClient = async () => {
  if (client?.isConnected) return client;
  client = new AmiClient({
    host: env.ASTERISK_AMI_HOST,
    port: Number(env.ASTERISK_AMI_PORT || 5038),
    username: env.ASTERISK_AMI_USERNAME,
    password: env.ASTERISK_AMI_PASSWORD,
    timeoutMs: 15000,
  });
  await client.connect();
  return client;
};
const prov = new Provisioner(getClient, OPTS);

const show = async (id) => (await getClient()).command(`pjsip show endpoint ${id}`);
const exists = async (id) => !/unable to find object/i.test(await show(id));

async function fileInContainer() {
  if (!env.PBX_MCP_IT_CONTAINER) return undefined;
  const { stdout } = await promisify(execFile)("docker", ["exec", env.PBX_MCP_IT_CONTAINER, "cat", `/etc/asterisk/${FILE}`]);
  return stdout;
}
const sections = (conf) => [...conf.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);

after(async () => {
  if (skip) return;
  for (const n of created.trunks) await prov.deleteTrunk({ name: n }).catch(() => {});
  for (const n of created.exts) await prov.deleteExtension({ number: n }).catch(() => {});
  client?.close();
});

test("IT: create, verify and delete a trunk", { skip }, async () => {
  const name = `it${process.pid}`;
  created.trunks.push(name);
  const r = await prov.createTrunk({ name, host: "192.0.2.50", port: 5062, context: "mcp-test", codecs: ["ulaw", "alaw"] });
  assert.match(r.verified, new RegExp(`Endpoint:\\s+mcp-${name}\\b`));
  assert.ok(await exists(`mcp-${name}`));

  const shown = await show(`mcp-${name}`);
  assert.match(shown, /ulaw/);
  assert.match(shown, new RegExp(`Aor:\\s+mcp-${name}\\b`));

  const conf = await fileInContainer();
  if (conf !== undefined) {
    assert.deepEqual(sections(conf), Array(3).fill(`mcp-${name}`)); // endpoint, aor, identify
    assert.match(conf, /contact\s*=\s*sip:192\.0\.2\.50:5062/);
    assert.match(conf, /match\s*=\s*192\.0\.2\.50/);
  }
  assert.ok((await prov.list()).some((o) => o.kind === "trunk" && o.name === name));
  await assert.rejects(prov.createTrunk({ name, host: "192.0.2.51", context: "mcp-test" }), /already exists/);

  await prov.deleteTrunk({ name });
  assert.ok(!(await exists(`mcp-${name}`)));
  const after = await fileInContainer();
  if (after !== undefined) assert.deepEqual(sections(after), []);
});

test("IT: create and delete an extension; a SIP REGISTER succeeds", { skip }, async () => {
  const number = `9${String(process.pid).slice(-4)}`;
  created.exts.push(number);
  const r = await prov.createExtension({ number, context: "mcp-test", codecs: ["ulaw"] });
  assert.ok(await exists(`mcp-${number}`));
  assert.ok(r.password.length >= 20);

  const conf = await fileInContainer();
  if (conf !== undefined) assert.deepEqual(sections(conf), Array(3).fill(`mcp-${number}`)); // endpoint, aor, auth

  // The SIP username is the endpoint name, mcp-<number>: PJSIP matches endpoint and AOR by it.
  const wrong = await sipRegister(`mcp-${number}`, "not-the-password");
  assert.notEqual(wrong.status, 200, "a wrong password must not register");
  const good = await sipRegister(`mcp-${number}`, r.password);
  assert.equal(good.status, 200, `REGISTER with the generated password: ${good.status} ${good.reason}`);
  assert.match(await (await getClient()).command(`pjsip show endpoint mcp-${number}`), /Contact:/);

  await prov.deleteExtension({ number });
  assert.ok(!(await exists(`mcp-${number}`)));
  const after = await fileInContainer();
  if (after !== undefined) assert.deepEqual(sections(after), []);
});

/** Minimal SIP REGISTER with digest auth over UDP; no dependencies. */
async function sipRegister(user, password) {
  const host = env.ASTERISK_AMI_HOST;
  const port = Number(env.PBX_MCP_IT_SIP_PORT || 5060);
  const sock = dgram.createSocket("udp4");
  await new Promise((res) => sock.connect(port, host, res));
  const localIp = sock.address().address;
  const localPort = sock.address().port;
  const callId = crypto.randomUUID();
  const tag = crypto.randomBytes(4).toString("hex");
  const uri = `sip:${host}`;
  const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

  const build = (cseq, auth) =>
    [
      `REGISTER ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${localIp}:${localPort};branch=z9hG4bK${crypto.randomBytes(6).toString("hex")};rport`,
      "Max-Forwards: 70",
      `From: <sip:${user}@${host}>;tag=${tag}`,
      `To: <sip:${user}@${host}>`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq} REGISTER`,
      `Contact: <sip:${user}@${localIp}:${localPort}>`,
      "Expires: 30",
      ...(auth ? [`Authorization: ${auth}`] : []),
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n");

  const exchange = (msg) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no SIP response")), 5000);
      const onMsg = (buf) => {
        const text = buf.toString();
        const m = /^SIP\/2\.0 (\d{3}) ([^\r\n]*)/.exec(text);
        if (!m || Number(m[1]) < 200) return; // ignore provisional responses
        clearTimeout(timer);
        sock.off("message", onMsg);
        resolve({ status: Number(m[1]), reason: m[2], text });
      };
      sock.on("message", onMsg);
      sock.send(msg);
    });

  try {
    const first = await exchange(build(1));
    if (first.status !== 401) return first;
    const hdr = (k) => new RegExp(`${k}="([^"]*)"`, "i").exec(first.text)?.[1];
    const realm = hdr("realm");
    const nonce = hdr("nonce");
    const response = md5(`${md5(`${user}:${realm}:${password}`)}:${nonce}:${md5(`REGISTER:${uri}`)}`);
    const auth = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5`;
    const second = await exchange(build(2, auth));
    if (second.status === 200) {
      // Unregister so nothing is left behind on the PBX.
      await exchange(build(3, auth).replace("Expires: 30", "Expires: 0")).catch(() => {});
    }
    return second;
  } finally {
    sock.close();
  }
}
