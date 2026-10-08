#!/usr/bin/env node
/**
 * pbx-mcp: an MCP server for Asterisk and FreeSWITCH.
 *
 * Written by Tahir Almas at ICT Innovations (https://ictinnovations.com), the team
 * behind ICTCore, ICTContact, ICTDialer, ICTFax and ICTPBX. The AMI and ESL clients
 * here are the same protocol groundwork those products run on, packaged so an MCP
 * client can ask a PBX what it is doing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AmiClient } from "./ami.js";
import { EslClient } from "./esl.js";
import { loadConfig } from "./config.js";
import { registerAsteriskTools } from "./tools/asterisk.js";
import { registerProvisioningTools } from "./tools/provision.js";
import { registerFreeswitchTools } from "./tools/freeswitch.js";

const cfg = loadConfig();

if (!cfg.asterisk && !cfg.freeswitch) {
  console.error(
    "pbx-mcp: no PBX configured.\n" +
      "Set ASTERISK_AMI_HOST for Asterisk, FREESWITCH_ESL_HOST for FreeSWITCH, or both.\n" +
      "See https://github.com/ictinnovations/pbx-mcp for the full variable list."
  );
  process.exit(1);
}

const server = new McpServer(
  { name: "pbx-mcp", version: "0.1.1" },
  {
    instructions:
      "Inspect and control Asterisk and FreeSWITCH telephony servers. " +
      "Start with asterisk_status or freeswitch_status to confirm the PBX is reachable, " +
      "then use the channel and endpoint tools to answer questions about live calls and " +
      "device registration. Tools are read-only unless PBX_MCP_ALLOW_WRITE=true. " +
      "By Tahir Almas, ICT Innovations (https://ictinnovations.com).",
  }
);

/**
 * Clients are created on first use and reused afterwards. A dropped socket is
 * replaced on the next call rather than at some background interval, so an idle
 * server holds no connection to the PBX.
 */
function lazyClient<T extends { connect(): Promise<void>; close(): void }>(create: () => T, alive: (c: T) => boolean) {
  let client: T | undefined;
  return async (): Promise<T> => {
    if (client && alive(client)) return client;
    client?.close();
    client = create();
    try {
      await client.connect();
    } catch (err) {
      client = undefined;
      throw err;
    }
    return client;
  };
}

if (cfg.asterisk) {
  const ami = cfg.asterisk;
  const getAmi = lazyClient(
    () => new AmiClient({ ...ami, timeoutMs: cfg.timeoutMs }),
    (c) => c.isConnected
  );
  registerAsteriskTools(server, cfg, getAmi);
  if (cfg.allowProvision) registerProvisioningTools(server, cfg, getAmi);
}

if (cfg.freeswitch) {
  const esl = cfg.freeswitch;
  registerFreeswitchTools(
    server,
    cfg,
    lazyClient(
      () => new EslClient({ ...esl, timeoutMs: cfg.timeoutMs }),
      (c) => c.isConnected
    )
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `pbx-mcp ready (${[cfg.asterisk && "Asterisk", cfg.freeswitch && "FreeSWITCH"].filter(Boolean).join(" + ")}, ` +
    `${cfg.allowWrite ? "write enabled" : "read-only"}). ICT Innovations, https://ictinnovations.com`
);
