/**
 * Configuration and the command safety policy.
 *
 * Part of pbx-mcp by Tahir Almas, ICT Innovations (https://ictinnovations.com).
 */

export interface Config {
  asterisk?: {
    host: string;
    port: number;
    username: string;
    password: string;
    tls: boolean;
  };
  freeswitch?: {
    host: string;
    port: number;
    password: string;
  };
  allowWrite: boolean;
  /** Dynamic trunk/extension provisioning, independent of allowWrite. */
  allowProvision: boolean;
  /** Managed PJSIP include file that provisioning is confined to. */
  pjsipFile: string;
  trunkAllow: string[];
  contextAllow: string[];
  timeoutMs: number;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg: Config = {
    allowWrite: /^(1|true|yes)$/i.test(env.PBX_MCP_ALLOW_WRITE ?? ""),
    allowProvision: /^(1|true|yes)$/i.test(env.PBX_MCP_ALLOW_PROVISION ?? ""),
    pjsipFile: env.PBX_MCP_PJSIP_FILE?.trim() || "pjsip_mcp.conf",
    trunkAllow: list(env.PBX_MCP_TRUNK_ALLOW),
    contextAllow: list(env.PBX_MCP_CONTEXT_ALLOW),
    timeoutMs: num(env.PBX_MCP_TIMEOUT_MS, 10000),
  };

  if (env.ASTERISK_AMI_HOST) {
    cfg.asterisk = {
      host: env.ASTERISK_AMI_HOST,
      port: num(env.ASTERISK_AMI_PORT, 5038),
      username: env.ASTERISK_AMI_USERNAME ?? "",
      password: env.ASTERISK_AMI_PASSWORD ?? "",
      tls: /^(1|true|yes)$/i.test(env.ASTERISK_AMI_TLS ?? ""),
    };
  }

  if (env.FREESWITCH_ESL_HOST) {
    cfg.freeswitch = {
      host: env.FREESWITCH_ESL_HOST,
      port: num(env.FREESWITCH_ESL_PORT, 8021),
      password: env.FREESWITCH_ESL_PASSWORD ?? "ClueCon",
    };
  }

  return cfg;
}

/**
 * Asterisk CLI commands the server will run in read-only mode.
 * Matching is on the start of the command, so "core show channels verbose" passes
 * under "core show". Anything not listed needs PBX_MCP_ALLOW_WRITE.
 */
export const ASTERISK_READ_PREFIXES = [
  "core show",
  "core get",
  "pjsip show",
  "pjsip list",
  "sip show",
  "iax2 show",
  "dialplan show",
  "database show",
  "database get",
  "queue show",
  "voicemail show",
  "manager show",
  "module show",
  "channel show",
  "cdr show",
  "http show",
  "rtp show",
  "stun show",
  "fax show",
  "confbridge list",
  "agent show",
  "devstate list",
  "hangupcause list",
  "logger show",
  "uptime",
];

/**
 * FreeSWITCH API commands the server will run in read-only mode, matched on the
 * start of the command the same way the Asterisk list is.
 *
 * Listing whole verbs does not work here. "sofia" and "db" own both readers and
 * writers, so the subcommand is the part that decides, and an earlier version of
 * this file tried to cover that by rejecting any command containing a word like
 * "restart". A deny list only catches the words somebody thought of: "conference
 * 3001 kick all" passed, because "kick" was never on it.
 */
export const FREESWITCH_READ_PREFIXES = [
  "status",
  "version",
  "uptime",
  "help",
  "show",
  "list_users",
  "global_getvar",
  "module_exists",
  "regex",
  "strftime",
  "sofia status",
  "sofia xmlstatus",
  "db list",
  "db exists",
  "db select",
];

/**
 * conference puts the room name before the subcommand, so no prefix can express
 * it: "conference 3001 list" reads and "conference 3001 kick all" does not.
 */
export const CONFERENCE_READ_SUBCOMMANDS = ["list", "xml_list", "count"];

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

export function checkAsteriskCommand(cli: string, allowWrite: boolean): PolicyResult {
  const cmd = cli.trim().toLowerCase().replace(/\s+/g, " ");
  if (!cmd) return { allowed: false, reason: "Empty command." };

  // Shell metacharacters have no place in an AMI Command action.
  if (/[;|&`$><\n\r]/.test(cli)) {
    return { allowed: false, reason: "Command contains shell metacharacters." };
  }

  if (allowWrite) return { allowed: true };

  const readOnly = ASTERISK_READ_PREFIXES.some((p) => cmd === p || cmd.startsWith(p + " "));
  if (readOnly) return { allowed: true };

  return {
    allowed: false,
    reason:
      `"${cli}" is not on the read-only allow list. ` +
      `Set PBX_MCP_ALLOW_WRITE=true to permit arbitrary CLI commands.`,
  };
}

export function checkFreeswitchCommand(command: string, allowWrite: boolean): PolicyResult {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "Empty command." };

  if (/[;|&`$><\n\r]/.test(trimmed)) {
    return { allowed: false, reason: "Command contains shell metacharacters." };
  }

  if (allowWrite) return { allowed: true };

  const words = trimmed.toLowerCase().replace(/\s+/g, " ").split(" ");
  const refuse = (what: string): PolicyResult => ({
    allowed: false,
    reason:
      `"${what}" is not on the read-only allow list. ` +
      `Set PBX_MCP_ALLOW_WRITE=true to permit arbitrary API commands.`,
  });

  if (words[0] === "conference") {
    // "conference list" with no room name lists every conference.
    const sub = words.length > 2 ? words[2] : words[1];
    if (sub && CONFERENCE_READ_SUBCOMMANDS.includes(sub)) return { allowed: true };
    return refuse(sub ? `conference ... ${sub}` : "conference");
  }

  const cmd = words.join(" ");
  const readOnly = FREESWITCH_READ_PREFIXES.some((p) => cmd === p || cmd.startsWith(p + " "));
  return readOnly ? { allowed: true } : refuse(cmd);
}

/** Reject anything that could inject extra AMI headers through a field value. */
export function assertNoHeaderInjection(label: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} may not contain carriage returns or newlines.`);
  }
}
