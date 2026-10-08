/**
 * Dynamic SIP trunk and extension provisioning for Asterisk (PJSIP) over AMI.
 *
 * Everything is written with UpdateConfig into one managed include file and
 * nowhere else. Objects are namespaced `mcp-`, so list and delete can only ever
 * see what this module created.
 *
 * PJSIP needs the endpoint, aor and auth/identify sections to share one name
 * (the registrar matches the AOR by the registering username). UpdateConfig
 * refuses to create a duplicate name, so siblings are created under a temporary
 * `<name>~<type>` and renamed; DelCat then uses a `type` catfilter to remove
 * exactly one of the same-named sections.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AmiClient, AmiMessage } from "./ami.js";
import { assertNoHeaderInjection } from "./config.js";

export const PREFIX = "mcp-";
export const CODECS = ["ulaw", "alaw", "g722", "g729", "opus"] as const;
export const TRANSPORTS = ["udp", "tcp", "tls"] as const;

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const CONTEXT = /^[A-Za-z0-9_.-]{1,64}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

const nameField = z.string().regex(NAME, "must match ^[A-Za-z0-9_-]{1,32}$");
const contextField = z.string().regex(CONTEXT, "may only contain letters, digits, dot, dash and underscore");
const codecsField = z.array(z.enum(CODECS)).min(1).max(CODECS.length).default(["ulaw", "alaw"]);

export const trunkShape = {
  name: nameField,
  host: z.string().regex(HOSTNAME, "must be an IPv4 address or a hostname"),
  port: z.number().int().min(1).max(65535).default(5060),
  transport: z.enum(TRANSPORTS).default("udp"),
  codecs: codecsField,
  context: contextField,
  dry_run: z.boolean().default(false),
};
export const extensionShape = {
  number: nameField,
  context: contextField,
  codecs: codecsField,
  dry_run: z.boolean().default(false),
};
export const trunkSchema = z.object(trunkShape);
export const extensionSchema = z.object(extensionShape);
export const nameSchema = z.object({ name: nameField });
export const numberSchema = z.object({ number: nameField });

export type TrunkInput = z.infer<typeof trunkSchema>;
export type ExtensionInput = z.infer<typeof extensionSchema>;

export interface Section {
  name: string;
  vars: Array<[string, string]>;
}

export interface ProvisionOptions {
  file: string;
  trunkAllow: string[];
  contextAllow: string[];
}

/** Shared by every value that ends up in the managed file. */
export function assertSafeValue(label: string, value: string): void {
  assertNoHeaderInjection(label, value);
  if (/^\s/.test(value)) throw new Error(`${label} may not start with whitespace.`);
  if (/[;#=]/.test(value)) throw new Error(`${label} may not contain ';', '#' or '='.`);
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
}

/** Is `ip` inside the CIDR (bare IPv4 means /32)? Throws on a malformed entry. */
function inCidr(ip: string, entry: string): boolean {
  const [base, bits = "32"] = entry.split("/");
  if (!IPV4.test(base) || !/^\d{1,2}$/.test(bits) || Number(bits) > 32) {
    throw new Error(`PBX_MCP_TRUNK_ALLOW entry "${entry}" is not a valid IPv4 CIDR.`);
  }
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipv4ToInt(ip) / size) === Math.floor(ipv4ToInt(base) / size);
}

const looksLikeIp = (entry: string) => entry.includes("/") || IPV4.test(entry);

/** Validate every entry up front, so a typo cannot hide behind an earlier entry that matched. */
export function assertTrunkAllowList(allow: string[]): void {
  for (const entry of allow) if (looksLikeIp(entry)) inCidr("0.0.0.0", entry);
}

/**
 * Fail closed: an empty allowlist refuses everything. Hostnames are matched
 * literally and never resolved, so DNS cannot be used to slip past the list.
 */
export function assertTrunkAllowed(host: string, allow: string[]): void {
  if (!allow.length) {
    throw new Error("Trunk creation is disabled: PBX_MCP_TRUNK_ALLOW is not set.");
  }
  const isIp = IPV4.test(host);
  const permitted = allow.some((entry) => {
    if (looksLikeIp(entry)) return isIp && inCidr(host, entry);
    return !isIp && entry.toLowerCase() === host.toLowerCase();
  });
  if (!permitted) throw new Error(`Host "${host}" is not on the PBX_MCP_TRUNK_ALLOW list.`);
}

export function assertContextAllowed(context: string, allow: string[]): void {
  if (!allow.includes(context)) {
    throw new Error(`Context "${context}" is not on the PBX_MCP_CONTEXT_ALLOW list.`);
  }
}

export function trunkSections(t: TrunkInput): Section[] {
  const id = PREFIX + t.name;
  return [
    {
      name: id,
      vars: [
        ["type", "endpoint"],
        ["transport", `transport-${t.transport}`],
        ["context", t.context],
        ["disallow", "all"],
        ["allow", t.codecs.join(",")],
        ["aors", id],
      ],
    },
    { name: id, vars: [["type", "aor"], ["contact", `sip:${t.host}:${t.port}`]] },
    { name: id, vars: [["type", "identify"], ["endpoint", id], ["match", t.host]] },
  ];
}

export const PASSWORD_PLACEHOLDER = "<generated on create>";

/** 24 URL-safe characters (144 bits); no ';', '#' or '=' by construction. */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

export function extensionSections(e: ExtensionInput, password: string): Section[] {
  const id = PREFIX + e.number;
  return [
    {
      name: id,
      vars: [
        ["type", "endpoint"],
        ["context", e.context],
        ["disallow", "all"],
        ["allow", e.codecs.join(",")],
        ["auth", id],
        ["aors", id],
      ],
    },
    { name: id, vars: [["type", "aor"], ["max_contacts", "1"], ["remove_existing", "yes"]] },
    {
      name: id,
      vars: [["type", "auth"], ["auth_type", "userpass"], ["username", id], ["password", password]],
    },
  ];
}

export function renderSections(sections: Section[]): string {
  return sections.map((s) => [`[${s.name}]`, ...s.vars.map(([k, v]) => `${k}=${v}`)].join("\n")).join("\n\n");
}

export interface Op {
  action: "newcat" | "append" | "delcat" | "renamecat";
  cat: string;
  var?: string;
  /** Append: the value. RenameCat: the new category name. */
  value?: string;
  /** Raw Options-N header; only ever built from fixed literals in this module. */
  options?: string;
}

/** Build the numbered-header UpdateConfig action: Action-000000, Cat-000000, Var-000000, Value-000000. */
export function updateConfigFields(file: string, ops: Op[]): AmiMessage {
  assertSafeValue("file", file);
  const fields: AmiMessage = { Action: "UpdateConfig", SrcFilename: file, DstFilename: file };
  ops.forEach((op, i) => {
    const n = String(i).padStart(6, "0");
    assertSafeValue("category", op.cat);
    fields[`Action-${n}`] = op.action;
    fields[`Cat-${n}`] = op.cat;
    if (op.var !== undefined) {
      assertSafeValue(op.var, op.value ?? "");
      fields[`Var-${n}`] = op.var;
    }
    if (op.value !== undefined) {
      assertSafeValue(op.var ?? "value", op.value);
      fields[`Value-${n}`] = op.value;
    }
    if (op.options !== undefined) fields[`Options-${n}`] = op.options;
  });
  return fields;
}

const get = (vars: Array<[string, string]> | undefined, key: string) => vars?.find(([k]) => k === key)?.[1];
const typeOf = (s: Section) => get(s.vars, "type") ?? "";

/**
 * NewCat refuses a name that already exists, so only the first section is
 * created under its real name; the rest are built under `<name>~<type>` (a
 * character the name regex forbids, so it cannot clash) and renamed into place.
 */
const createOps = (sections: Section[]): Op[] =>
  sections.flatMap((s, i) => {
    const tmp = i === 0 ? s.name : `${s.name}~${typeOf(s)}`;
    return [
      { action: "newcat" as const, cat: tmp },
      ...s.vars.map(([v, value]) => ({ action: "append" as const, cat: tmp, var: v, value })),
      ...(i === 0 ? [] : [{ action: "renamecat" as const, cat: tmp, value: s.name }]),
    ];
  });

/** Same-named sections are told apart by their `type`, so DelCat removes exactly one. */
const deleteOps = (targets: Array<{ name: string; type: string }>): Op[] =>
  targets.map((t) => ({ action: "delcat", cat: t.name, options: `catfilter="type=^${t.type}$"` }));

export interface ManagedObject {
  kind: "trunk" | "extension";
  name: string;
  context: string;
  transport?: string;
  codecs: string;
  contact?: string;
  match?: string;
}

export interface Created {
  verified: string;
  config: string;
  password?: string;
}

interface Cat {
  name: string;
  vars: Array<[string, string]>;
}

/** Parse a GetConfig reply into categories in file order; names may repeat. */
function parseCategories(msgs: AmiMessage[]): Cat[] {
  const res = msgs[0] ?? {};
  if ((res.Response ?? "").toLowerCase() === "error") throw new Error(res.Message ?? "GetConfig failed.");
  const cats: Cat[] = [];
  for (const [key, name] of Object.entries(res)) {
    const m = /^Category-(\d+)$/.exec(key);
    if (!m) continue;
    const vars: Array<[string, string]> = [];
    for (let j = 0; res[`Line-${m[1]}-${String(j).padStart(6, "0")}`] !== undefined; j++) {
      const line = res[`Line-${m[1]}-${String(j).padStart(6, "0")}`];
      const eq = line.indexOf("=");
      if (eq > 0) vars.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
    }
    cats.push({ name, vars });
  }
  return cats;
}

const find = (cats: Cat[], name: string, type: string) =>
  cats.find((c) => c.name === name && get(c.vars, "type") === type);

export class Provisioner {
  /** UpdateConfig is read-modify-write, so provisioning operations run one at a time. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private getClient: () => Promise<AmiClient>,
    private opts: ProvisionOptions
  ) {
    // pjsip.conf is hand-maintained; provisioning is confined to one include file beside it. AMI `config`
    // can write any file, so the name is limited to pjsip_*.conf (never manager.conf, extensions.conf, ...).
    if (!/^pjsip_[A-Za-z0-9_.-]+\.conf$/i.test(opts.file)) {
      throw new Error(`PBX_MCP_PJSIP_FILE "${opts.file}" must be a bare pjsip_*.conf file name (e.g. pjsip_mcp.conf).`);
    }
    assertTrunkAllowList(opts.trunkAllow);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  async createTrunk(raw: unknown): Promise<Created> {
    const input = trunkSchema.parse(raw);
    assertTrunkAllowed(input.host, this.opts.trunkAllow);
    assertContextAllowed(input.context, this.opts.contextAllow);
    const sections = trunkSections(input);
    // Check every value before dry_run too, so a dry run cannot approve what create would refuse.
    updateConfigFields(this.opts.file, createOps(sections));
    const config = renderSections(sections);
    if (input.dry_run) return { verified: "", config };
    return this.serialized(() => this.create(PREFIX + input.name, sections, config));
  }

  async createExtension(raw: unknown): Promise<Created> {
    const input = extensionSchema.parse(raw);
    assertContextAllowed(input.context, this.opts.contextAllow);
    const password = generatePassword();
    const sections = extensionSections(input, password);
    updateConfigFields(this.opts.file, createOps(sections));
    // The block shown to the caller never carries the real secret.
    const config = renderSections(extensionSections(input, PASSWORD_PLACEHOLDER));
    if (input.dry_run) return { verified: "", config };
    const created = await this.serialized(() => this.create(PREFIX + input.number, sections, config, password));
    return { ...created, password };
  }

  private async create(id: string, sections: Section[], config: string, secret?: string): Promise<Created> {
    const ami = await this.getClient();
    const existing = await this.categories(ami);
    if (existing.some((c) => c.name === id)) {
      throw new Error(`"${id}" already exists in ${this.opts.file}; refusing to overwrite.`);
    }

    const rollback = async () => {
      try {
        const names = new Set(sections.map((s) => s.name));
        if (!(await this.categories(ami)).some((c) => names.has(c.name))) return "Nothing to roll back; nothing was written.";
        await this.update(ami, deleteOps(sections.map((s) => ({ name: s.name, type: typeOf(s) }))));
        await this.reload(ami);
        return "Rolled back.";
      } catch (err) {
        return `Rollback FAILED (${(err as Error).message}); remove [${id}] from ${this.opts.file} by hand.`;
      }
    };

    try {
      await this.update(ami, createOps(sections));
    } catch (err) {
      // A timeout may mean Asterisk applied the change but the reply was lost; a plain rejection applied nothing.
      if (!/timed out/i.test((err as Error).message)) throw err;
      throw new Error(`${(err as Error).message} The change may have been applied. ${await rollback()}`);
    }

    let shown: string;
    try {
      await this.reload(ami);
      shown = await ami.command(`pjsip show endpoint ${id}`);
      if (!endpointExists(shown, id)) throw new Error(`Asterisk does not report endpoint ${id} after reload.`);
    } catch (err) {
      throw new Error(
        `Verification failed: ${(err as Error).message} ${await rollback()} ` +
          `Is "#include ${this.opts.file}" present in pjsip.conf, and does Asterisk have write access to ${this.opts.file}?`
      );
    }
    return { verified: secret ? shown.split(secret).join("***") : shown, config };
  }

  async list(): Promise<ManagedObject[]> {
    return this.serialized(async () => {
      const cats = await this.categories(await this.getClient());
      const out: ManagedObject[] = [];
      for (const { name, vars } of cats) {
        if (get(vars, "type") !== "endpoint") continue;
        const identify = find(cats, name, "identify");
        if (!identify && !find(cats, name, "auth")) continue;
        out.push({
          kind: identify ? "trunk" : "extension",
          name: name.slice(PREFIX.length),
          context: get(vars, "context") ?? "",
          transport: get(vars, "transport"),
          codecs: get(vars, "allow") ?? "",
          contact: get(find(cats, name, "aor")?.vars, "contact"),
          match: get(identify?.vars, "match"),
        });
      }
      return out;
    });
  }

  async deleteTrunk(raw: unknown): Promise<string> {
    return this.remove("trunk", nameSchema.parse(raw).name);
  }

  async deleteExtension(raw: unknown): Promise<string> {
    return this.remove("extension", numberSchema.parse(raw).number);
  }

  private remove(kind: "trunk" | "extension", name: string): Promise<string> {
    const id = PREFIX + name;
    const sibling = kind === "trunk" ? "identify" : "auth";
    return this.serialized(async () => {
      const ami = await this.getClient();
      const cats = await this.categories(ami);
      if (!find(cats, id, "endpoint") || !find(cats, id, sibling)) {
        throw new Error(`No managed ${kind} "${name}" in ${this.opts.file}; nothing deleted.`);
      }
      const types = ["endpoint", "aor", sibling].filter((t) => find(cats, id, t));
      await this.update(ami, deleteOps(types.map((type) => ({ name: id, type }))));
      await this.reload(ami);
      if (endpointExists(await ami.command(`pjsip show endpoint ${id}`), id)) {
        throw new Error(`Removed [${id}] (${types.join(", ")}) from ${this.opts.file}, but Asterisk still reports it.`);
      }
      return `Deleted ${kind} ${name} ([${id}]: ${types.join(", ")}); Asterisk no longer reports ${id}.`;
    });
  }

  /** Managed-file categories, restricted to our namespace. */
  private async categories(ami: AmiClient): Promise<Cat[]> {
    const all = parseCategories(await ami.action({ Action: "GetConfig", Filename: this.opts.file }));
    return all.filter((c) => c.name.startsWith(PREFIX));
  }

  private async update(ami: AmiClient, ops: Op[]): Promise<void> {
    const res = (await ami.action(updateConfigFields(this.opts.file, ops)))[0] ?? {};
    if ((res.Response ?? "").toLowerCase() !== "success") {
      throw new Error(`UpdateConfig rejected: ${res.Message ?? "no message"}`);
    }
  }

  private async reload(ami: AmiClient): Promise<void> {
    const out = await ami.command("module reload res_pjsip.so");
    if (!/reloaded successfully/i.test(out)) throw new Error(`res_pjsip reload failed: ${out.trim() || "no output"}`);
  }
}

/** `pjsip show endpoint` answers Success with "Unable to find object" for a missing one. */
function endpointExists(output: string, id: string): boolean {
  return !/unable to find object/i.test(output) && new RegExp(`Endpoint:\\s+${id}\\b`).test(output);
}
