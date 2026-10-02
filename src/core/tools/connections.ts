import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { modeOf, type ConnectionStore } from "../connections/store.js";
import type { Connection } from "../types.js";
import { capJson } from "./output.js";

export interface ConnectionToolDeps {
  store: Pick<ConnectionStore, "list" | "resolve" | "upsert" | "remove">;
  /** Tests pin the clock. */
  now?: () => Date;
}

/** A DNS name with at least two labels, e.g. contoso.local. Not a NetBIOS name, not a DN. */
export const DOMAIN_NAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

function publicView(c: Connection) {
  return { alias: c.alias, domain: c.domain, mode: modeOf(c), addedAt: c.addedAt };
}

const connectionShape = z.object({
  alias: z.string(),
  domain: z.string(),
  mode: z.enum(["read", "write"]),
  addedAt: z.string(),
});

export function registerConnectionTools(server: McpServer, deps: ConnectionToolDeps): void {
  const now = deps.now ?? (() => new Date());

  server.registerTool(
    "connections_list",
    {
      title: "List domain connections",
      description: "List the Active Directory domains this server can reach, with each one's mode. Use the alias or the domain name as the domain argument of execute.",
      inputSchema: {},
      outputSchema: { connections: z.array(connectionShape) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const connections = (await deps.store.list()).map(publicView);
      return { content: [{ type: "text", text: capJson({ connections }).text }], structuredContent: { connections } };
    },
  );

  server.registerTool(
    "connection_add",
    {
      title: "Add a domain connection",
      description:
        "Add an Active Directory domain by its DNS name. No sign-in: every call runs as the Windows user this server runs as, so that user's own permissions apply. A read connection refuses every add, modify, delete and move; choose write only when the person wants changes made. Adding an alias that exists replaces it.",
      inputSchema: {
        domain: z.string().describe("The domain's DNS name, e.g. contoso.local."),
        alias: z.string().optional().describe("Short name for the connection. Defaults to the domain name."),
        mode: z.enum(["read", "write"]).optional().describe("Defaults to read."),
      },
      outputSchema: { connection: connectionShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ domain, alias, mode }) => {
      if (!DOMAIN_NAME_RE.test(domain)) {
        return {
          isError: true,
          content: [{ type: "text", text: `"${domain}" is not a domain's DNS name. Pass something like contoso.local, not a NetBIOS name or a DN.` }],
        };
      }
      const connection: Connection = { alias: alias ?? domain.toLowerCase(), domain: domain.toLowerCase(), mode: mode ?? "read", addedAt: now().toISOString() };
      await deps.store.upsert(connection);
      const view = publicView(connection);
      return { content: [{ type: "text", text: capJson({ connection: view }).text }], structuredContent: { connection: view } };
    },
  );

  server.registerTool(
    "connection_remove",
    {
      title: "Remove a domain connection",
      description: "Remove a stored domain connection. Nothing in the domain changes.",
      inputSchema: { alias: z.string() },
      outputSchema: { removed: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ alias }) => {
      const removed = await deps.store.remove(alias);
      return { content: [{ type: "text", text: JSON.stringify({ removed }) }], structuredContent: { removed } };
    },
  );
}
