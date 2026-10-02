import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATALOGUE_TYPES, type CatalogueCache } from "../catalogue/catalogue.js";
import type { ConnectionStore } from "../connections/store.js";
import type { RunResult, Sandbox } from "../sandbox/sandbox.js";
import { DEFAULT_MAX_CHARS, capJson, shedToFit } from "./output.js";

export const SEARCH_DESCRIPTION = `Search one domain's Active Directory catalogue: every class and attribute in its schema, which attributes are confidential, each attribute's syntax and whether it holds one value, which attributes a class may hold, the LDAP controls the domain controller supports, and the extended rights. Use it before execute to find the right attribute or class rather than guessing.

The catalogue is read from the domain the first time you search it, which takes a few seconds, and kept for the session. Pass refresh: true after a schema change. Your script runs with no network and cannot reach the domain.

Write the body of an async function and "return" the value you want back. Output is capped at about 10,000 tokens, so filter inside the script.

Available in the script:
${CATALOGUE_TYPES}

Examples:
// Confidential attributes
return Object.entries(catalogue.attributes).filter(([, a]) => a.confidential).map(([n]) => n);

// Attributes about passwords, with their syntax
return Object.entries(catalogue.attributes).filter(([n]) => /pwd|password/i.test(n)).map(([n, a]) => ({ n, syntax: a.syntax, single: a.single }));

// Everything a user object may hold
return catalogue.classes.user.may.length;`;

export const CATALOGUE_TRUNCATION_NOTE = "Output was truncated. Count, filter, or return fewer entries inside the script.";

export interface SearchDeps {
  store: Pick<ConnectionStore, "resolve">;
  catalogues: Pick<CatalogueCache, "get">;
  /** A sandbox with no network, so a catalogue script cannot reach the domain. */
  catalogueSandbox: Pick<Sandbox, "run">;
}

interface SearchOutput {
  [key: string]: unknown;
  ok: boolean;
  domain: string;
  result?: unknown;
  error?: { name: string; message: string; line?: number };
  logs: string[];
  truncated: boolean;
}

const outputSchema = {
  ok: z.boolean(),
  domain: z.string(),
  result: z.unknown().optional(),
  error: z.object({ name: z.string(), message: z.string(), line: z.number().optional() }).optional(),
  logs: z.array(z.string()),
  truncated: z.boolean(),
};

/**
 * The catalogue goes in front of the script on one line of its own. The sandbox counts lines from
 * the script it was given, so the failing line it reports is one more than the script's own.
 */
export function withCatalogue(catalogueJson: string, code: string): string {
  return `const catalogue = ${catalogueJson};\n${code}`;
}

function scriptLine(run: RunResult): RunResult {
  const line = run.error?.line;
  if (!run.error || line === undefined) return run;
  const { line: _drop, ...rest } = run.error;
  return { ...run, error: line > 1 ? { ...rest, line: line - 1 } : rest };
}

export function registerSearchTool(server: McpServer, deps: SearchDeps): void {
  server.registerTool(
    "search",
    {
      title: "Search the AD catalogue",
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        domain: z.string().describe("Connection alias or the domain's DNS name. See connections_list."),
        code: z.string().describe("Body of an async JavaScript function over `catalogue`. Return a value."),
        refresh: z.boolean().optional().describe("Read the catalogue from the domain again. Defaults to false."),
      },
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ domain, code, refresh }) => {
      const connection = await deps.store.resolve(domain);
      if (!connection) {
        return { isError: true, content: [{ type: "text", text: `No connection named "${domain}". Call connections_list to see aliases, or connection_add to add the domain.` }] };
      }
      let json: string;
      try {
        json = JSON.stringify(await deps.catalogues.get(connection.domain, refresh ?? false));
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Could not read the catalogue from ${connection.domain}: ${(err as Error).message}` }] };
      }
      const run = scriptLine(await deps.catalogueSandbox.run(withCatalogue(json, code)));
      const base = { ok: run.ok, domain: connection.domain, ...(run.error ? { error: { name: run.error.name, message: run.error.message, ...(run.error.line !== undefined ? { line: run.error.line } : {}) } } : {}) };
      const capped = capJson(run.data);
      const structured = shedToFit<SearchOutput>(
        [
          { ...base, ...(run.ok ? { result: capped.truncated ? capped.text : run.data } : {}), logs: run.logs, truncated: capped.truncated },
          { ...base, ...(run.ok ? { result: capped.truncated ? capped.text : run.data } : {}), logs: [], truncated: true },
          { ...base, ...(run.ok ? { result: capJson(run.data, Math.floor(DEFAULT_MAX_CHARS / 2)).text } : {}), logs: [], truncated: true },
        ],
        DEFAULT_MAX_CHARS,
      );
      const text = structured.truncated ? `${capJson(structured).text}\n\n${CATALOGUE_TRUNCATION_NOTE}` : capJson(structured).text;
      return { content: [{ type: "text", text }], structuredContent: structured };
    },
  );
}
