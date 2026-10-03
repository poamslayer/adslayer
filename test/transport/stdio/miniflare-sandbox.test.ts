import { describe, it, expect, afterAll } from "vitest";
import { MiniflareSandbox, NO_OUTBOUND } from "../../../src/transport/stdio/miniflare-sandbox.js";

const sandbox = new MiniflareSandbox({ timeoutMs: 5_000 });
afterAll(() => sandbox.dispose());

const noBinding = async () => {
  throw new Error("no binding in this test");
};

describe("MiniflareSandbox.run", () => {
  it("returns the value the script returns", async () => {
    const r = await sandbox.run("return 1 + 1;", noBinding);
    expect(r).toMatchObject({ ok: true, data: 2, logs: [] });
  });

  it("routes ad.* calls to the handler and returns its value", async () => {
    const seen: unknown[] = [];
    const handler = async (op: string, args: unknown[]) => {
      seen.push([op, ...args]);
      return { dn: args[0] };
    };
    const r = await sandbox.run("const u = await ad.get('CN=a,DC=x', ['name']); return u.dn;", handler);
    expect(r.ok).toBe(true);
    expect(r.data).toBe("CN=a,DC=x");
    expect(seen).toEqual([["get", "CN=a,DC=x", ["name"], undefined]]);
  });

  it("passes undefined for a missing optional argument", async () => {
    const seen: unknown[][] = [];
    const handler = async (_op: string, args: unknown[]) => {
      seen.push(args);
      return 1;
    };
    await sandbox.run("return ad.get('CN=a,DC=x');", handler);
    expect(seen).toEqual([["CN=a,DC=x", undefined, undefined]]);
  });

  it("allows several binding calls in flight at once", async () => {
    let inFlight = 0;
    let max = 0;
    const handler = async (_op: string, args: unknown[]) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return args[0];
    };
    const r = await sandbox.run("return Promise.all([ad.get('CN=a'), ad.get('CN=b'), ad.get('CN=c')]);", handler);
    expect(r.data).toEqual(["CN=a", "CN=b", "CN=c"]);
    expect(max).toBeGreaterThan(1);
  });

  it("surfaces handler errors as script errors the script can catch", async () => {
    const handler = async () => {
      throw new Error("InsufficientAccessRights: no");
    };
    const r = await sandbox.run("try { await ad.get('CN=x'); return 'no'; } catch (e) { return e.message; }", handler);
    expect(r.data).toBe("InsufficientAccessRights: no");
  });

  it("captures console output", async () => {
    const r = await sandbox.run("console.log('hello', 2); console.error('bad'); return null;", noBinding);
    expect(r.logs).toEqual(["hello 2", "bad"]);
  });

  it("caps console output", async () => {
    const small = new MiniflareSandbox({ timeoutMs: 5_000, maxLogLines: 3 });
    try {
      const r = await small.run("for (let i = 0; i < 10; i++) console.log(i); return null;", noBinding);
      expect(r.logs).toEqual(["0", "1", "2"]);
    } finally {
      await small.dispose();
    }
  });

  it("marks the logs when the character cap is reached", async () => {
    const small = new MiniflareSandbox({ timeoutMs: 5_000, maxLogLines: 50, maxLogChars: 40 });
    try {
      const r = await small.run("for (let i = 0; i < 10; i++) console.log('x'.repeat(20)); return null;", noBinding);
      expect(r.logs.at(-1)).toBe("[log output truncated]");
      expect(r.logs.join("").length).toBeLessThan(200);
    } finally {
      await small.dispose();
    }
  });

  it("reports script errors with a message", async () => {
    const r = await sandbox.run("throw new Error('boom');", noBinding);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("boom");
  });

  it("reports the failing line of the script itself", async () => {
    const r = await sandbox.run("const a = 1;\nconst b = 2;\nthrow new Error('boom');", noBinding);
    expect(r.ok).toBe(false);
    expect(r.error?.line).toBe(3);
  });

  it("reports syntax errors", async () => {
    const r = await sandbox.run("return (;", noBinding);
    expect(r.ok).toBe(false);
    expect(`${r.error?.name} ${r.error?.message}`).toMatch(/SyntaxError|Unexpected/);
  });

  it("has no process, require, or filesystem", async () => {
    const r = await sandbox.run("return { process: typeof process, require: typeof require };", noBinding);
    expect(r.data).toEqual({ process: "undefined", require: "undefined" });
    const fs = await sandbox.run("const m = await import('node:fs'); return typeof m.readFileSync;", noBinding);
    expect(fs.ok).toBe(false);
  });

  it("cannot reach any host other than the binding", async () => {
    const r = await sandbox.run("const res = await fetch('https://example.com'); return { status: res.status };", noBinding);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ status: 403 });
  });

  it("stops a runaway script at the deadline and recovers for the next run", async () => {
    const short = new MiniflareSandbox({ timeoutMs: 1_000 });
    try {
      const r = await short.run("while (true) {}", noBinding);
      expect(r.ok).toBe(false);
      expect(r.error?.name).toBe("TimeoutError");
      const again = await short.run("return 42;", noBinding);
      expect(again.data).toBe(42);
    } finally {
      await short.dispose();
    }
  });
});

describe("a sandbox built without the AD service binding", () => {
  const noNetwork = new MiniflareSandbox({ timeoutMs: 5_000, adServiceBinding: false });
  afterAll(() => noNetwork.dispose());

  it.each([
    ["the binding host", "https://ad.local/get"],
    ["another hostname", "https://example.com"],
    ["an IP", "http://127.0.0.1:1/"],
  ])("cannot reach %s", async (_what, url) => {
    const r = await noNetwork.run(
      `try { const res = await fetch(${JSON.stringify(url)}); return { reached: res.status }; } catch (e) { return { failed: e.message }; }`,
    );
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ failed: expect.stringContaining("not permitted to access the internet") });
  });

  it("reports a script error naming the line, exactly as a sandbox with one does", async () => {
    const r = await noNetwork.run("const a = 1;\nconst b = 2;\nthrow new Error('boom');");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("boom");
    expect(r.error?.line).toBe(3);
  });

  it("holds the deadline and recreates the runtime for the next run", async () => {
    const short = new MiniflareSandbox({ timeoutMs: 1_000, adServiceBinding: false });
    try {
      const r = await short.run("while (true) {}");
      expect(r.ok).toBe(false);
      expect(r.error?.name).toBe("TimeoutError");
      expect((await short.run("return 42;")).data).toBe(42);
    } finally {
      await short.dispose();
    }
  });

  it("caps console output", async () => {
    const small = new MiniflareSandbox({ timeoutMs: 5_000, adServiceBinding: false, maxLogLines: 3 });
    try {
      const r = await small.run("for (let i = 0; i < 10; i++) console.log(i); return null;");
      expect(r.logs).toEqual(["0", "1", "2"]);
    } finally {
      await small.dispose();
    }
  });

  it("does not inherit the host worker's outbound, so `?? null` cannot be dropped", async () => {
    const r = await noNetwork.run(
      "try { const res = await fetch('https://example.com'); return { reached: await res.text() }; } catch (e) { return { failed: e.message }; }",
    );
    // A bare `env.AD` reads as "inherit the parent", which lands on the host worker's
    // own outbound. Seeing that marker means the sandbox has a network again.
    expect(JSON.stringify(r.data)).not.toContain(NO_OUTBOUND);
    expect(r.data).toMatchObject({ failed: expect.stringContaining("not permitted to access the internet") });
  });
});

describe("a sandbox built with a preamble", () => {
  const withPreamble = new MiniflareSandbox({ timeoutMs: 5_000, preamble: "const answer = 42;" });
  afterAll(() => withPreamble.dispose());

  it("puts the preamble in front of every script it runs", async () => {
    expect((await withPreamble.run("return answer;", noBinding)).data).toBe(42);
    expect((await withPreamble.run("return answer + 1;", noBinding)).data).toBe(43);
  });

  it("still reports the script's own failing line, however many lines it spans", async () => {
    const multiline = new MiniflareSandbox({ timeoutMs: 5_000, preamble: "const a = 1;\nconst b = 2;\nconst c = 3;" });
    try {
      const r = await multiline.run("const x = 1;\nthrow new Error('boom');", noBinding);
      expect(r.ok).toBe(false);
      expect(r.error?.line).toBe(2);
    } finally {
      await multiline.dispose();
    }
  });

  it("is not seen by a sandbox built without one", async () => {
    expect((await sandbox.run("return typeof answer;", noBinding)).data).toBe("undefined");
  });
});

describe("workerdStartHint", () => {
  it("names the Visual C++ runtime when it is missing on Windows", async () => {
    const { workerdStartHint, VC_RUNTIME_URL } = await import("../../../src/transport/stdio/miniflare-sandbox.js");
    const seen: string[] = [];
    const hint = workerdStartHint("win32", (f) => (seen.push(f), false), "C:\\Windows");
    expect(hint).toContain("Visual C++ Redistributable");
    expect(hint).toContain(VC_RUNTIME_URL);
    expect(seen).toEqual(["C:\\Windows\\System32\\vcruntime140_1.dll"]);
  });

  it("says nothing when the runtime is there, or off Windows", async () => {
    const { workerdStartHint } = await import("../../../src/transport/stdio/miniflare-sandbox.js");
    expect(workerdStartHint("win32", () => true)).toBeUndefined();
    expect(workerdStartHint("linux", () => false)).toBeUndefined();
  });
});
