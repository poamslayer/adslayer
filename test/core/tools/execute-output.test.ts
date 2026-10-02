import { describe, it, expect } from "vitest";
import { shapeRunOutput } from "../../../src/core/tools/execute.js";
import type { RunResult } from "../../../src/core/sandbox/sandbox.js";
import type { AdCallRecord } from "../../../src/core/types.js";

const call: AdCallRecord = { op: "search", target: "OU=Lab,DC=x", ok: true, ms: 1 };

function run(over: Partial<RunResult> = {}): RunResult {
  return { ok: true, data: { a: 1 }, logs: [], ...over };
}

describe("shapeRunOutput", () => {
  it("keeps everything and flags nothing when the payload is small", () => {
    const out = shapeRunOutput(run(), "t1", [call]);
    expect(out).toMatchObject({ ok: true, domain: "t1", result: { a: 1 }, truncated: false });
    expect(out.calls).toHaveLength(1);
    expect(out.logs).toEqual([]);
  });

  it("flags truncation when the result alone is over the cap", () => {
    const out = shapeRunOutput(run({ data: { s: "x".repeat(500) } }), "t1", [], 100);
    expect(out.truncated).toBe(true);
    expect(typeof out.result).toBe("string");
  });

  it("sheds the logged lines before the call records, and still flags truncation", () => {
    const logs = Array.from({ length: 50 }, (_, i) => `line ${i} ${"y".repeat(40)}`);
    const out = shapeRunOutput(run({ logs }), "t1", [call], 600);
    expect(out.truncated).toBe(true);
    expect(out.logs).toEqual([]);
    expect(out.calls).toHaveLength(1);
    expect(out.result).toEqual({ a: 1 });
  });

  it("sheds the call records when the logged lines were not enough", () => {
    const calls = Array.from({ length: 200 }, () => call);
    const out = shapeRunOutput(run({ logs: ["noisy"] }), "t1", calls, 400);
    expect(out.truncated).toBe(true);
    expect(out.logs).toEqual([]);
    expect(out.calls).toEqual([]);
  });

  it("never returns a payload over the cap, even when the result dominates", () => {
    const calls = Array.from({ length: 200 }, () => call);
    const logs = Array.from({ length: 200 }, (_, i) => `log ${i}`);
    const out = shapeRunOutput(run({ data: { s: "z".repeat(100_000) }, logs }), "t1", calls, 1000);
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(1000);
  });

  it("carries the failing line of a script error", () => {
    const out = shapeRunOutput(
      { ok: false, logs: ["before"], error: { name: "Error", message: "boom", line: 3 } },
      "t1",
      [],
    );
    expect(out.ok).toBe(false);
    expect(out.error).toEqual({ name: "Error", message: "boom", line: 3 });
    expect(out.result).toBeUndefined();
    expect(out.logs).toEqual(["before"]);
  });
});
