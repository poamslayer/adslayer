import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionStore, modeOf } from "../../../src/core/connections/store.js";
import type { Connection } from "../../../src/core/types.js";

const lab: Connection = { alias: "lab", domain: "lab.adslayer.test", mode: "read", addedAt: "2026-10-02T00:00:00.000Z" };

describe("ConnectionStore", () => {
  let dir: string;
  let store: ConnectionStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "adslayer-store-"));
    store = new ConnectionStore(join(dir, "nested", "connections.json"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("starts empty when there is no file", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("stores, resolves by alias or by domain name in any case, and removes", async () => {
    await store.upsert(lab);
    expect(await store.resolve("lab")).toEqual(lab);
    expect(await store.resolve("LAB.adslayer.TEST")).toEqual(lab);
    expect(await store.resolve("other")).toBeUndefined();
    expect(await store.remove("lab")).toBe(true);
    expect(await store.remove("lab")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("replaces a connection with the same alias", async () => {
    await store.upsert(lab);
    await store.upsert({ ...lab, mode: "write" });
    expect(await store.list()).toEqual([{ ...lab, mode: "write" }]);
  });

  it("writes a file only its owner can read", async () => {
    await store.upsert(lab);
    if (process.platform !== "win32") expect((await stat(join(dir, "nested", "connections.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, "nested", "connections.json"), "utf8"))).toEqual({ version: 1, connections: [lab] });
  });

  it("reads a file with no connections array as empty", async () => {
    const file = join(dir, "bad.json");
    await writeFile(file, JSON.stringify({ version: 1 }));
    expect(await new ConnectionStore(file).list()).toEqual([]);
  });
});

describe("modeOf", () => {
  it("reads a missing mode as read, never write (ADR-0004)", () => {
    expect(modeOf({})).toBe("read");
    expect(modeOf({ mode: "write" })).toBe("write");
  });
});
