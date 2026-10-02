import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../src/core/server.js";
import { DEFAULT_MAX_CHARS } from "../../../src/core/tools/output.js";
import { learnResults, type DocsResult } from "../../../src/core/tools/docs.js";

async function connect(searchDocs: (query: string) => Promise<DocsResult[]>) {
  const server = createServer({
    store: { list: async () => [], resolve: async () => undefined } as never,
    client: {} as never,
    auth: {} as never,
    sandbox: { run: vi.fn() },
    indexSandbox: () => { throw new Error("no index run in this test"); },
    searchDocs,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(ct);
  return mcp;
}

const result = (n: number, text = "Lists the policies."): DocsResult => ({
  title: `Page ${n}`,
  url: `https://learn.microsoft.com/graph/api/page-${n}`,
  text,
});

describe("docs (#78)", () => {
  it("is registered as a read-only tool that reaches outside, taking only a query", async () => {
    const mcp = await connect(async () => []);
    const tool = (await mcp.listTools()).tools.find((t) => t.name === "docs");

    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties)).toEqual(["query"]);
    expect(tool?.description).toContain("Microsoft Learn");
  });

  it("searches with the query and returns each result's title, link and text", async () => {
    const searchDocs = vi.fn(async () => [result(1), result(2)]);
    const mcp = await connect(searchDocs);

    const res = await mcp.callTool({ name: "docs", arguments: { query: "list conditional access policies" } });

    expect(searchDocs).toHaveBeenCalledWith("list conditional access policies");
    expect(res.structuredContent).toEqual({ results: [result(1), result(2)], truncated: false });
  });

  it("drops results from the end to stay inside the output cap, and says so", async () => {
    const big = "x".repeat(Math.floor(DEFAULT_MAX_CHARS / 4));
    const mcp = await connect(async () => [1, 2, 3, 4, 5, 6].map((n) => result(n, big)));

    const res = await mcp.callTool({ name: "docs", arguments: { query: "anything" } });
    const sc = res.structuredContent as { results: DocsResult[]; truncated: boolean };

    expect(sc.truncated).toBe(true);
    expect(sc.results.length).toBeLessThan(6);
    expect(sc.results[0].title).toBe("Page 1");
    expect(JSON.stringify(sc).length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
  });

  it("reports a failed search as a tool error that names Microsoft Learn", async () => {
    const mcp = await connect(async () => { throw new Error("fetch failed"); });

    const res = await mcp.callTool({ name: "docs", arguments: { query: "anything" } });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Microsoft Learn.*fetch failed/);
  });
});

describe("learnResults", () => {
  const raw = { results: [{ title: "List policies", content: "GET /identity/conditionalAccess/policies", contentUrl: "https://learn.microsoft.com/x" }] };
  const expected = [{ title: "List policies", url: "https://learn.microsoft.com/x", text: "GET /identity/conditionalAccess/policies" }];

  it("reads Learn's structured content", () => {
    expect(learnResults({ structuredContent: raw, content: [] })).toEqual(expected);
  });

  it("falls back to the JSON in its text content", () => {
    expect(learnResults({ content: [{ type: "text", text: JSON.stringify(raw) }] })).toEqual(expected);
  });

  it("throws on an answer it cannot read, rather than returning nothing", () => {
    expect(() => learnResults({ content: [{ type: "text", text: "not json" }] })).toThrow(/could not read/);
  });
});
