import { afterAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LdapError } from "../../../src/core/ldap/backend.js";
import { createServer } from "../../../src/core/server.js";
import { EXECUTE_DESCRIPTION } from "../../../src/core/tools/execute.js";
import type { Connection } from "../../../src/core/types.js";
import { MiniflareSandbox } from "../../../src/transport/stdio/miniflare-sandbox.js";

const read: Connection = { alias: "lab", domain: "lab.adslayer.test", mode: "read", addedAt: "x" };
const write: Connection = { alias: "lab-w", domain: "lab.adslayer.test", mode: "write", addedAt: "x" };
const sandbox = new MiniflareSandbox({ timeoutMs: 10_000 });
afterAll(() => sandbox.dispose());

async function connect(call: (domain: string, op: string, args: Record<string, unknown>) => Promise<unknown>) {
  const backend = { call: vi.fn(call) };
  const store = { resolve: async (k: string) => [read, write].find((c) => c.alias === k || c.domain === k), list: async () => [read, write], upsert: async () => {}, remove: async () => false };
  const server = createServer({ store: store as never, backend, sandbox, catalogueSandbox: sandbox });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(a);
  return { mcp, backend };
}

type Out = { ok: boolean; domain: string; result: unknown; error?: { message: string }; calls: Array<{ op: string; ok: boolean; code?: string }> };

describe("execute", () => {
  it("tells the model about the ad object, read mode, and the logged-on user", () => {
    expect(EXECUTE_DESCRIPTION).toContain("declare const ad");
    expect(EXECUTE_DESCRIPTION).toContain("read mode refuses add, modify, delete, move, addAce and removeAce");
    expect(EXECUTE_DESCRIPTION).toContain("runs as the Windows user");
  });

  it("runs a script whose ad.search reaches the backend for the connection's domain", async () => {
    const { mcp, backend } = await connect(async () => ({ entries: [{ dn: "CN=a", attributes: { sAMAccountName: ["a"] } }, { dn: "CN=b", attributes: { sAMAccountName: ["b"] } }], more: false }));
    const res = await mcp.callTool({ name: "execute", arguments: { domain: "lab", code: `const r = await ad.search({ filter: "(objectClass=user)", attributes: ["sAMAccountName"] }); return r.entries.map(e => e.attributes.sAMAccountName[0]);` } });
    const out = res.structuredContent as Out;
    expect(out).toMatchObject({ ok: true, domain: "lab.adslayer.test", result: ["a", "b"] });
    expect(out.calls).toMatchObject([{ op: "search", ok: true }]);
    expect(backend.call).toHaveBeenCalledWith("lab.adslayer.test", "search", { filter: "(objectClass=user)", scope: "sub", attributes: ["sAMAccountName"] });
    await mcp.close();
  });

  it("refuses a write on a read connection inside the script, before the backend sees it", async () => {
    const { mcp, backend } = await connect(async () => ({ dn: "x" }));
    const res = await mcp.callTool({ name: "execute", arguments: { domain: "lab", code: `await ad.delete("CN=a,DC=x"); return "deleted";` } });
    const out = res.structuredContent as Out;
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/read mode, so it cannot delete/);
    expect(backend.call).not.toHaveBeenCalled();
    await mcp.close();
  });

  it("restores a deleted object with showDeleted on both the search and the modify", async () => {
    const gone = { dn: "CN=Jane\\0ADEL:1,CN=Deleted Objects,DC=x", attributes: { lastKnownParent: ["OU=Lab,DC=x"], "msDS-LastKnownRDN": ["Jane"] } };
    const { mcp, backend } = await connect(async (_d, op) => (op === "search" ? { entries: [gone], more: false } : { dn: "CN=Jane,OU=Lab,DC=x" }));
    const res = await mcp.callTool({ name: "execute", arguments: { domain: "lab-w", code: `
      const controls = { showDeleted: true };
      const g = (await ad.search({ base: "CN=Deleted Objects,DC=x", filter: "(isDeleted=TRUE)", attributes: ["lastKnownParent", "msDS-LastKnownRDN"], controls })).entries[0];
      return await ad.modify(g.dn, [{ op: "delete", attribute: "isDeleted" }, { op: "replace", attribute: "distinguishedName", values: "CN=" + g.attributes["msDS-LastKnownRDN"][0] + "," + g.attributes.lastKnownParent[0] }], { controls });` } });
    expect((res.structuredContent as Out).result).toEqual({ dn: "CN=Jane,OU=Lab,DC=x" });
    expect(backend.call.mock.calls[1][2]).toEqual({
      dn: gone.dn,
      changes: [{ op: "delete", attribute: "isDeleted" }, { op: "replace", attribute: "distinguishedName", values: "CN=Jane,OU=Lab,DC=x" }],
      controls: { showDeleted: true },
    });
    expect(backend.call.mock.calls[0][2]).toMatchObject({ controls: { showDeleted: true } });
    await mcp.close();
  });

  it("writes through a write connection", async () => {
    const { mcp, backend } = await connect(async (_d, op) => (op === "modify" ? { dn: "CN=a,DC=x" } : {}));
    const res = await mcp.callTool({ name: "execute", arguments: { domain: "lab-w", code: `return await ad.modify("CN=a,DC=x", [{ op: "replace", attribute: "description", values: "hi" }]);` } });
    expect((res.structuredContent as Out).result).toEqual({ dn: "CN=a,DC=x" });
    expect(backend.call).toHaveBeenCalledTimes(1);
    await mcp.close();
  });

  it("lets the script catch an AD refusal by its code", async () => {
    const { mcp } = await connect(async () => {
      throw new LdapError("InsufficientAccessRights", "no");
    });
    const res = await mcp.callTool({ name: "execute", arguments: { domain: "lab-w", code: `try { await ad.modify("CN=a", [{ op: "delete", attribute: "d" }]); } catch (e) { return e.message; }` } });
    const out = res.structuredContent as Out;
    expect(out.result).toBe("InsufficientAccessRights: no");
    expect(out.calls).toMatchObject([{ op: "modify", ok: false, code: "InsufficientAccessRights" }]);
    await mcp.close();
  });

  it("answers an unknown domain with how to add one", async () => {
    const { mcp } = await connect(async () => ({}));
    const res = await mcp.callTool({ name: "execute", arguments: { domain: "nope.local", code: "return 1;" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("connection_add");
    await mcp.close();
  });
});
