import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION, USER_AGENT } from "../version.js";
import { DEFAULT_MAX_CHARS, shedToFit } from "./output.js";

export interface DocsResult {
  title: string;
  url: string;
  text: string;
}

export interface DocsDeps {
  /** Answers a query with documentation chunks. Defaults to Microsoft Learn; tests pass their own. */
  searchDocs?: (query: string) => Promise<DocsResult[]>;
}

/**
 * Microsoft's own Learn MCP server. It is public, needs no key, and answers a question with page
 * chunks of about 2,000 characters, each with its title and link. Kept from graphslayer. ADR-0001.
 */
const LEARN_MCP_URL = "https://learn.microsoft.com/api/mcp";
const LEARN_SEARCH_TOOL = "microsoft_docs_search";
const LEARN_TIMEOUT_MS = 15_000;

export const DOCS_DESCRIPTION = `Search the Microsoft Learn documentation. Use it to answer how something in Active Directory works before or instead of reading a domain: Active Directory Domain Services, LDAP and its controls, the schema, Group Policy and its settings, Windows LAPS, delegation and permissions, and the Recycle Bin.

Returns the most relevant passages, each with its page title and link. To find an attribute or a policy setting, use search.`;

/** Reads Learn's answer, which carries `{ results: [{ title, content, contentUrl }] }` as structured content and as JSON text. */
export function learnResults(answer: { structuredContent?: unknown; content?: unknown }): DocsResult[] {
  const fromText = () => {
    const first = Array.isArray(answer.content) ? (answer.content[0] as { type?: string; text?: string } | undefined) : undefined;
    try {
      return first?.type === "text" && first.text ? JSON.parse(first.text) : undefined;
    } catch {
      return undefined;
    }
  };
  const body = (answer.structuredContent ?? fromText()) as { results?: unknown } | undefined;
  if (!body || !Array.isArray(body.results)) throw new Error("could not read the answer from Microsoft Learn");
  return body.results.map((r) => {
    const item = r as { title?: unknown; content?: unknown; contentUrl?: unknown };
    return { title: String(item.title ?? ""), url: String(item.contentUrl ?? ""), text: String(item.content ?? "") };
  });
}

/** One connection per query, closed after it, so an idle server holds nothing open to Learn. */
export async function searchMicrosoftLearn(query: string): Promise<DocsResult[]> {
  const client = new Client({ name: SERVER_NAME, version: SERVER_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(LEARN_MCP_URL), {
    requestInit: { headers: { "user-agent": USER_AGENT } },
  });
  try {
    await client.connect(transport, { timeout: LEARN_TIMEOUT_MS });
    const answer = await client.callTool({ name: LEARN_SEARCH_TOOL, arguments: { query } }, undefined, { timeout: LEARN_TIMEOUT_MS });
    if (answer.isError) throw new Error(JSON.stringify(answer.content).slice(0, 300));
    return learnResults(answer as { structuredContent?: unknown; content?: unknown });
  } finally {
    await client.close().catch(() => {});
  }
}

interface DocsOutput {
  // The MCP SDK types structured content as an open record.
  [key: string]: unknown;
  results: DocsResult[];
  truncated: boolean;
}

const outputSchema = {
  results: z.array(z.object({ title: z.string(), url: z.string(), text: z.string() })),
  truncated: z.boolean(),
};

export function registerDocsTool(server: McpServer, deps: DocsDeps): void {
  const searchDocs = deps.searchDocs ?? searchMicrosoftLearn;
  server.registerTool(
    "docs",
    {
      title: "Search Microsoft Learn",
      description: DOCS_DESCRIPTION,
      inputSchema: { query: z.string().describe("What to look up, in plain words.") },
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      let results: DocsResult[];
      try {
        results = await searchDocs(query);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Microsoft Learn search failed: ${(err as Error).message}` }] };
      }
      // Whole passages are kept and the last ones dropped: a passage cut mid-sentence reads as
      // if the page said less than it does.
      const candidates: DocsOutput[] = results.map((_, i) => ({ results: results.slice(0, results.length - i), truncated: i > 0 }));
      const bare: DocsOutput = { results: [], truncated: results.length > 0 };
      const structured = shedToFit<DocsOutput>(candidates.length ? [candidates[0], ...candidates.slice(1), bare] : [bare], DEFAULT_MAX_CHARS);
      return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
    },
  );
}
