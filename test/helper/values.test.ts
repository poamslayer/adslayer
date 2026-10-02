/**
 * The helper's value conversion, run in real PowerShell. A `{ base64 }` value has to reach
 * System.DirectoryServices.Protocols as a byte[]: PowerShell unrolls an array a function returns,
 * and an unrolled one is sent as a string of numbers, which is how a password reset through
 * unicodePwd once failed with UnwillingToPerform.
 *
 * Only the Values section of the helper runs, because the whole script starts its read loop.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HELPER_SCRIPT } from "../../src/transport/stdio/powershell-helper.js";

const run = promisify(execFile);

/** pwsh wherever it is installed, else Windows PowerShell 5.1 on Windows. */
function findPowerShell(): string | undefined {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh"];
  for (const name of names) for (const dir of dirs) if (existsSync(join(dir, name))) return join(dir, name);
  return undefined;
}
const shell = findPowerShell();

function valuesSection(): string {
  const source = readFileSync(HELPER_SCRIPT, "utf8");
  const start = source.indexOf("# --- Values");
  const end = source.indexOf("# --- Search");
  if (start === -1 || end === -1) throw new Error("the helper no longer has a Values section between Values and Search");
  return source.slice(start, end);
}

/** Runs ConvertFrom-JsonValues on a JSON value and describes each converted value. */
async function convert(json: unknown): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "adslayer-values-"));
  try {
    const file = join(dir, "values.ps1");
    await writeFile(file, [
      "$ErrorActionPreference = 'Stop'",
      valuesSection(),
      `$r = ConvertFrom-JsonValues ('${JSON.stringify(json).replace(/'/g, "''")}' | ConvertFrom-Json)`,
      "foreach ($v in $r) { if ($v -is [byte[]]) { 'bytes:' + [Convert]::ToBase64String($v) } else { $v.GetType().Name + ':' + $v } }",
    ].join("\n"));
    const { stdout } = await run(shell!, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", file]);
    return stdout.split(/\r?\n/).filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!shell)("the helper's attribute values", () => {
  it("keeps one { base64 } value a byte[], as unicodePwd needs", async () => {
    expect(await convert({ base64: "IgBhACIA" })).toEqual(["bytes:IgBhACIA"]);
  }, 30_000);

  it("keeps each { base64 } in a list a byte[] of its own", async () => {
    expect(await convert([{ base64: "AQID" }, { base64: "BAU=" }])).toEqual(["bytes:AQID", "bytes:BAU="]);
  }, 30_000);

  it("sends strings, numbers and booleans as strings", async () => {
    expect(await convert(["a", 514, true])).toEqual(["String:a", "String:514", "String:TRUE"]);
  }, 30_000);
});
