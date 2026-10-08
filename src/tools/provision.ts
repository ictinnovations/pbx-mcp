/**
 * Provisioning tools: SIP trunks and extension endpoints for Asterisk (PJSIP).
 * Registered only when PBX_MCP_ALLOW_PROVISION=true, independent of PBX_MCP_ALLOW_WRITE.
 */

import { ZodError } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AmiClient } from "../ami.js";
import type { Config } from "../config.js";
import {
  CODECS,
  extensionShape,
  nameSchema,
  numberSchema,
  Provisioner,
  trunkShape,
  type ManagedObject,
} from "../provision.js";
import { asTable, clamp, text, toolError, type ToolResult } from "./format.js";

const fail = (err: unknown): ToolResult =>
  err instanceof ZodError
    ? text(`Error: invalid input: ${err.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`, true)
    : toolError(err);

const ok = (body: string) => text(clamp(body));

export function registerProvisioningTools(server: McpServer, cfg: Config, getClient: () => Promise<AmiClient>) {
  const prov = new Provisioner(getClient, {
    file: cfg.pjsipFile,
    trunkAllow: cfg.trunkAllow,
    contextAllow: cfg.contextAllow,
  });
  const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  const deletes = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

  server.registerTool(
    "asterisk_trunk_create",
    {
      title: "Create an IP-authenticated SIP trunk",
      description:
        "Create a PJSIP trunk (endpoint, aor and identify, all prefixed 'mcp-') to a peer that Asterisk " +
        "recognises by source IP. The host must be on PBX_MCP_TRUNK_ALLOW and the context on " +
        "PBX_MCP_CONTEXT_ALLOW. Fails if the name exists. Reloads res_pjsip and verifies the endpoint, " +
        `rolling back on failure. Use dry_run=true to see the exact config without touching Asterisk. Codecs: ${CODECS.join(", ")}.`,
      inputSchema: trunkShape,
      annotations: writes,
    },
    async (args) => {
      try {
        const r = await prov.createTrunk(args);
        return ok(
          r.verified
            ? `Created and verified trunk mcp-${args.name}.\n\n${r.config}\n\n${r.verified}`
            : `Dry run, nothing sent to Asterisk. This block would be written:\n\n${r.config}`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "asterisk_trunk_list",
    {
      title: "List managed SIP trunks",
      description: "List the trunks created by asterisk_trunk_create (only 'mcp-' objects in the managed file).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(describe(await prov.list(), "trunk"));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "asterisk_trunk_delete",
    {
      title: "Delete a managed SIP trunk",
      description: "Delete a trunk created by asterisk_trunk_create. Only 'mcp-' trunks in the managed file can be deleted.",
      inputSchema: { name: nameSchema.shape.name },
      annotations: deletes,
    },
    async (args) => {
      try {
        return ok(await prov.deleteTrunk(args));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "asterisk_extension_create",
    {
      title: "Create a SIP extension (registerable endpoint)",
      description:
        "Create a PJSIP endpoint that a phone registers to (endpoint, aor and auth, prefixed 'mcp-'). This is " +
        "not a dialplan extension. The SIP username is mcp-<number>. The password is generated server-side and returned once, in this response " +
        "only; it cannot be retrieved later. The context must be on PBX_MCP_CONTEXT_ALLOW. Fails if the number " +
        "exists. Use dry_run=true to preview the config without touching Asterisk.",
      inputSchema: extensionShape,
      annotations: writes,
    },
    async (args) => {
      try {
        const r = await prov.createExtension(args);
        return ok(
          r.verified
            ? `Created and verified extension mcp-${args.number}.\n` +
                `SIP username: mcp-${args.number} (the endpoint name; register with this, not the bare number)\nPassword: ${r.password}\n` +
                `The password is shown once and cannot be retrieved again.\n\n${r.config}\n\n${r.verified}`
            : `Dry run, nothing sent to Asterisk. This block would be written:\n\n${r.config}`
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "asterisk_extension_list",
    {
      title: "List managed SIP extensions",
      description: "List the extensions created by asterisk_extension_create. Passwords are never shown.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(describe(await prov.list(), "extension"));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "asterisk_extension_delete",
    {
      title: "Delete a managed SIP extension",
      description: "Delete an extension created by asterisk_extension_create. Only 'mcp-' extensions in the managed file can be deleted.",
      inputSchema: { number: numberSchema.shape.number },
      annotations: deletes,
    },
    async (args) => {
      try {
        return ok(await prov.deleteExtension(args));
      } catch (err) {
        return fail(err);
      }
    }
  );
}

function describe(all: ManagedObject[], kind: "trunk" | "extension"): string {
  const rows = all.filter((o) => o.kind === kind).map((o) => ({ ...o }) as Record<string, string>);
  if (!rows.length) return `No managed ${kind}s.`;
  const columns: Array<[string, string]> =
    kind === "trunk"
      ? [["Name", "name"], ["Contact", "contact"], ["Match", "match"], ["Transport", "transport"], ["Context", "context"], ["Codecs", "codecs"]]
      : [["Number", "name"], ["Context", "context"], ["Codecs", "codecs"]];
  return `${asTable(rows, columns)}\n\n${rows.length} ${kind}(s).`;
}
