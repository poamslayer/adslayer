import { afterAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTool, withCatalogue } from "../../../src/core/tools/search.js";
import type { Connection } from "../../../src/core/types.js";
import { MiniflareSandbox } from "../../../src/transport/stdio/miniflare-sandbox.js";

const lab: Connection = { alias: "lab", domain: "lab.test", mode: "read", addedAt: "x" };
const catalogue = { domain: "lab.test", attributes: { member: { syntax: "DN", single: false }, "msLAPS-Password": { syntax: "UnicodeString", single: true, confidential: true } } };
const sandbox = new MiniflareSandbox({ timeoutMs: 10_000, adServiceBinding: false });
afterAll(() => sandbox.dispose());

async function connect(get = vi.fn(async () => catalogue as never)) {
  const server = new McpServer({ name: "t", version: "0" });
  registerSearchTool(server, { store: { resolve: async (k: string) => (k === "lab" ? lab : undefined) }, catalogues: { get }, catalogueSandbox: sandbox });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(a);
  return { mcp, get };
}

describe("search", () => {
  it("runs the script over the domain's catalogue", async () => {
    const { mcp, get } = await connect();
    const res = await mcp.callTool({ name: "search", arguments: { domain: "lab", code: "return Object.entries(catalogue.attributes).filter(([, a]) => a.confidential).map(([n]) => n);" } });
    expect(res.structuredContent).toMatchObject({ ok: true, domain: "lab.test", result: ["msLAPS-Password"], truncated: false });
    expect(get).toHaveBeenCalledWith("lab.test", false);
    await mcp.close();
  });

  it("passes refresh through", async () => {
    const { mcp, get } = await connect();
    await mcp.callTool({ name: "search", arguments: { domain: "lab", code: "return 1", refresh: true } });
    expect(get).toHaveBeenCalledWith("lab.test", true);
    await mcp.close();
  });

  it("reports the script's own failing line, not the catalogue line", async () => {
    const { mcp } = await connect();
    const res = await mcp.callTool({ name: "search", arguments: { domain: "lab", code: "const x = 1;\nthrow new Error('boom');" } });
    expect(res.structuredContent).toMatchObject({ ok: false, error: { message: "boom", line: 2 } });
    await mcp.close();
  });

  it("has no network, so a catalogue script cannot reach the domain", async () => {
    const { mcp } = await connect();
    const res = await mcp.callTool({ name: "search", arguments: { domain: "lab", code: "try { await fetch('https://ad.local/search'); return 'reached'; } catch (e) { return 'blocked'; }" } });
    expect((res.structuredContent as { result: unknown }).result).toBe("blocked");
    await mcp.close();
  });

  it("says when the catalogue cannot be read, and when the domain is unknown", async () => {
    const { mcp } = await connect(vi.fn(async () => { throw new Error("NotWindows: no"); }));
    const failed = await mcp.callTool({ name: "search", arguments: { domain: "lab", code: "return 1" } });
    expect(failed.isError).toBe(true);
    expect((failed.content as Array<{ text: string }>)[0].text).toContain("Could not read the catalogue from lab.test");
    const unknown = await mcp.callTool({ name: "search", arguments: { domain: "nope", code: "return 1" } });
    expect((unknown.content as Array<{ text: string }>)[0].text).toContain("connection_add");
    await mcp.close();
  });
});

describe("withCatalogue", () => {
  it("puts the catalogue on its own first line", () => {
    expect(withCatalogue('{"a":1}', "return catalogue.a;")).toBe('const catalogue = {"a":1};\nreturn catalogue.a;');
  });
});
