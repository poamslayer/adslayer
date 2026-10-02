import { describe, expect, it, vi } from "vitest";
import { connect, isEntryPoint, parseArgs } from "../../src/cli/main.js";

describe("parseArgs", () => {
  it("serves with no arguments", () => expect(parseArgs([])).toEqual({ command: "serve" }));
  it("reads help, connections and disconnect", () => {
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
    expect(parseArgs(["connections"])).toEqual({ command: "connections" });
    expect(parseArgs(["disconnect", "lab"])).toEqual({ command: "disconnect", alias: "lab" });
  });
  it("reads connect with a domain, defaulting to read", () => {
    expect(parseArgs(["connect", "Lab.AdSlayer.test"])).toEqual({ command: "connect", domain: "lab.adslayer.test", mode: "read" });
    expect(parseArgs(["connect", "lab.adslayer.test", "--alias", "lab", "--mode", "write"])).toEqual({ command: "connect", domain: "lab.adslayer.test", alias: "lab", mode: "write" });
  });
  it.each([
    [["connect"], /needs a domain/],
    [["connect", "LAB"], /not a domain's DNS name/],
    [["connect", "a.b", "--mode", "admin"], /read or write/],
    [["connect", "a.b", "--alias"], /Missing value/],
    [["connect", "a.b", "--cloud", "x"], /Unknown flag/],
    [["disconnect"], /needs an alias/],
    [["frob"], /Unknown command/],
  ])("rejects %j", (argv, message) => expect(() => parseArgs(argv)).toThrow(message));
});

describe("connect", () => {
  it("stores the connection and says it runs as the Windows user", async () => {
    const store = { upsert: vi.fn(async () => {}) };
    const text = await connect(store, { command: "connect", domain: "lab.adslayer.test", mode: "write" }, () => new Date("2026-10-02T00:00:00.000Z"));
    expect(store.upsert).toHaveBeenCalledWith({ alias: "lab.adslayer.test", domain: "lab.adslayer.test", mode: "write", addedAt: "2026-10-02T00:00:00.000Z" });
    expect(text).toContain("mode write");
    expect(text).toContain("Windows user");
  });
});

describe("isEntryPoint", () => {
  it("is false with no argv[1]", () => expect(isEntryPoint(undefined, import.meta.url)).toBe(false));
});
