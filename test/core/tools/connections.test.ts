import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConnectionStore } from "../../../src/core/connections/store.js";
import { DOMAIN_NAME_RE, registerConnectionTools } from "../../../src/core/tools/connections.js";

describe("connection tools", () => {
  let dir: string;
  let store: ConnectionStore;
  let mcp: Client;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "adslayer-conn-"));
    store = new ConnectionStore(join(dir, "connections.json"));
    const server = new McpServer({ name: "t", version: "0" });
    registerConnectionTools(server, { store, now: () => new Date("2026-10-02T00:00:00.000Z") });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(a);
  });
  afterEach(async () => {
    await mcp.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("adds a domain in read mode by default, named by its DNS name, with no sign-in", async () => {
    const res = await mcp.callTool({ name: "connection_add", arguments: { domain: "Lab.AdSlayer.test" } });
    expect(res.structuredContent).toEqual({ connection: { alias: "lab.adslayer.test", domain: "lab.adslayer.test", mode: "read", addedAt: "2026-10-02T00:00:00.000Z" } });
    expect(await store.list()).toHaveLength(1);
  });

  it("lets the agent add a write connection (ADR-0005)", async () => {
    await mcp.callTool({ name: "connection_add", arguments: { domain: "lab.adslayer.test", alias: "lab", mode: "write" } });
    expect((await store.resolve("lab"))?.mode).toBe("write");
  });

  it("refuses something that is not a domain's DNS name", async () => {
    for (const domain of ["LAB", "DC=lab,DC=adslayer,DC=test", "lab..test", "-lab.test"]) {
      const res = await mcp.callTool({ name: "connection_add", arguments: { domain } });
      expect(res.isError, domain).toBe(true);
    }
    expect(await store.list()).toEqual([]);
  });

  it("lists and removes", async () => {
    await mcp.callTool({ name: "connection_add", arguments: { domain: "lab.adslayer.test", alias: "lab" } });
    const listed = await mcp.callTool({ name: "connections_list", arguments: {} });
    expect((listed.structuredContent as { connections: unknown[] }).connections).toEqual([
      { alias: "lab", domain: "lab.adslayer.test", mode: "read", addedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    expect((await mcp.callTool({ name: "connection_remove", arguments: { alias: "lab" } })).structuredContent).toEqual({ removed: true });
    expect((await mcp.callTool({ name: "connection_remove", arguments: { alias: "lab" } })).structuredContent).toEqual({ removed: false });
  });
});

describe("DOMAIN_NAME_RE", () => {
  it.each(["contoso.local", "lab.adslayer.test", "a-b.c-d.e"])("accepts %s", (d) => expect(DOMAIN_NAME_RE.test(d)).toBe(true));
  it.each(["contoso", "contoso.", ".local", "con_toso.local", "a b.local"])("rejects %s", (d) => expect(DOMAIN_NAME_RE.test(d)).toBe(false));
});
