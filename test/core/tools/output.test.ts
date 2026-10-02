import { describe, it, expect } from "vitest";
import { capJson, shedToFit } from "../../../src/core/tools/output.js";

describe("capJson", () => {
  it("returns compact json and no truncation when small", () => {
    const r = capJson({ a: 1, b: [1, 2] }, 1000);
    expect(r.text).toBe('{"a":1,"b":[1,2]}');
    expect(r.truncated).toBe(false);
  });

  it("cuts at the limit and flags truncation", () => {
    const r = capJson({ s: "x".repeat(500) }, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100 + "\n...[truncated]".length);
    expect(r.text.endsWith("...[truncated]")).toBe(true);
  });

  it("handles undefined and circular values", () => {
    expect(capJson(undefined, 10).text).toBe("null");
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(capJson(o, 100).text).toContain("Circular");
  });
});

describe("shedToFit", () => {
  it("takes the first candidate that fits", () => {
    const chosen = shedToFit([{ keep: "x".repeat(200) }, { keep: "x" }], 50);
    expect(chosen).toEqual({ keep: "x" });
  });

  it("takes the last candidate when none of them fit, rather than nothing", () => {
    // Every tool result has to come back in the declared shape, so the ladder's last rung is
    // the smallest payload the shaper can build and not an absence of one.
    const chosen = shedToFit([{ keep: "x".repeat(200) }, { keep: "x".repeat(100) }], 10);
    expect(chosen).toEqual({ keep: "x".repeat(100) });
  });
});
