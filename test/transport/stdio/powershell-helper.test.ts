import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LdapError } from "../../../src/core/ldap/backend.js";
import { HELPER_SCRIPT, PowerShellHelper, helperCommand } from "../../../src/transport/stdio/powershell-helper.js";
import { existsSync } from "node:fs";

const FAKE = { file: process.execPath, args: [fileURLToPath(new URL("../../fixtures/fake-helper.mjs", import.meta.url))] };
const helpers: PowerShellHelper[] = [];
function helper(requestTimeoutMs?: number) {
  const h = new PowerShellHelper({ command: FAKE, ...(requestTimeoutMs ? { requestTimeoutMs } : {}) });
  helpers.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(helpers.splice(0).map((h) => h.dispose()));
});

describe("PowerShellHelper", () => {
  it("sends the domain inside the args and resolves with the value", async () => {
    const v = (await helper().call("lab.adslayer.test", "echo", { base: "OU=Lab" })) as { args: unknown };
    expect(v.args).toEqual({ domain: "lab.adslayer.test", base: "OU=Lab" });
  });

  it("matches answers to calls by id when they finish out of order", async () => {
    const h = helper();
    // The fake handles lines as they arrive, so the short one answers first.
    const [a, b] = await Promise.all([h.call("d.test", "slow", { ms: 150 }), h.call("d.test", "slow", { ms: 10 })]);
    expect([a, b]).toEqual([150, 10]);
  });

  it("keeps one process for many calls", async () => {
    const h = helper();
    const pids = new Set<number>();
    for (let i = 0; i < 20; i += 1) pids.add(((await h.call("d.test", "echo", {})) as { pid: number }).pid);
    expect(pids.size).toBe(1);
  });

  it("rejects with LdapError carrying the helper's code", async () => {
    const err = await helper().call("d.test", "fail", {}).catch((e) => e);
    expect(err).toBeInstanceOf(LdapError);
    expect(err).toMatchObject({ code: "InsufficientAccessRights", message: "no" });
  });

  it("ignores a stdout line that is not JSON", async () => {
    expect(await helper().call("d.test", "garbage", {})).toBe("after garbage");
  });

  it("fails the waiting call when the helper dies, with its last output, and restarts on the next call", async () => {
    const h = helper();
    const first = ((await h.call("d.test", "echo", {})) as { pid: number }).pid;
    const err = await h.call("d.test", "crash", {}).catch((e) => e as Error);
    expect(err.message).toMatch(/exited \(code 3\)/);
    expect(err.message).toContain("about to crash");
    const second = ((await h.call("d.test", "echo", {})) as { pid: number }).pid;
    expect(second).not.toBe(first);
  });

  it("gives up on a call that never answers, and starts a fresh helper after", async () => {
    const h = helper(300);
    const first = ((await h.call("d.test", "echo", {})) as { pid: number }).pid;
    await expect(h.call("d.test", "hang", {})).rejects.toThrow(/did not answer hang within 0.3 seconds/);
    const second = ((await h.call("d.test", "echo", {})) as { pid: number }).pid;
    expect(second).not.toBe(first);
  });

  it("says a missing program could not start", async () => {
    const h = new PowerShellHelper({ command: { file: "definitely-not-a-real-program-adslayer", args: [] } });
    helpers.push(h);
    await expect(h.call("d.test", "echo", {})).rejects.toThrow(/could not start/);
  });

  it("refuses off Windows when no command is given (ADR-0002)", async () => {
    const h = new PowerShellHelper({ platform: "darwin" });
    const err = await h.call("d.test", "whoami", {}).catch((e) => e);
    expect(err).toMatchObject({ code: "NotWindows" });
  });

  it("dispose ends the helper and fails what was still waiting", async () => {
    const h = helper();
    // The expectation is attached before dispose, which is what rejects the call.
    const settled = expect(h.call("d.test", "hang", {})).rejects.toThrow(/shutting down/);
    await h.dispose();
    await settled;
  });
});

describe("helperCommand", () => {
  it("runs the shipped helper script with no profile and no prompts", () => {
    expect(existsSync(HELPER_SCRIPT)).toBe(true);
    const c = helperCommand({ ADSLAYER_POWERSHELL: "C:\\pwsh.exe" });
    expect(c).toEqual({ file: "C:\\pwsh.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER_SCRIPT] });
  });

  it("falls back to Windows PowerShell 5.1 when PowerShell 7 is not installed", () => {
    expect(helperCommand({ ProgramFiles: "/nowhere" }).file).toBe("powershell.exe");
  });
});
