import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/core/config.js";

describe("resolveConfig", () => {
  it("keeps state in ~/.adslayer by default", () => {
    const c = resolveConfig({ HOME: "/home/a" });
    expect(c.homeDir).toBe(path.join("/home/a", ".adslayer"));
    expect(c.connectionsFile).toBe(path.join("/home/a", ".adslayer", "connections.json"));
  });

  it("uses USERPROFILE on Windows, where HOME is usually unset", () => {
    expect(resolveConfig({ USERPROFILE: "C:\\Users\\a" }).homeDir).toBe(path.join("C:\\Users\\a", ".adslayer"));
  });

  it("lets ADSLAYER_HOME move it", () => {
    expect(resolveConfig({ HOME: "/home/a", ADSLAYER_HOME: "/tmp/x" }).connectionsFile).toBe(path.join("/tmp/x", "connections.json"));
  });
});
