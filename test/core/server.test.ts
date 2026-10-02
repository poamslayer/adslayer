import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/core/server.js";

describe("createServer", () => {
  it("lists the same six tools however many connections there are", async () => {
    const server = createServer({
      store: { resolve: async () => undefined, list: async () => [], upsert: async () => {}, remove: async () => false } as never,
      backend: { call: async () => { throw new Error("no call in this test"); } },
      sandbox: { run: async () => { throw new Error("no run in this test"); } },
      catalogueSandbox: { run: async () => { throw new Error("no run in this test"); } },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(clientTransport);
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["connection_add", "connection_remove", "connections_list", "docs", "execute", "search"]);
    await mcp.close();
  });
});
