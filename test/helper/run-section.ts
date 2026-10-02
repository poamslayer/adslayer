/**
 * Runs one section of the helper in real PowerShell. Only a section runs, because the whole
 * script starts its read loop. A section runs from its "# --- Name" banner to the next banner.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HELPER_SCRIPT } from "../../src/transport/stdio/powershell-helper.js";

const run = promisify(execFile);

/** pwsh wherever it is installed, else Windows PowerShell 5.1 on Windows. */
function findPowerShell(): string | undefined {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh"];
  for (const name of names) for (const dir of dirs) if (existsSync(join(dir, name))) return join(dir, name);
  return undefined;
}
export const shell = findPowerShell();

function section(name: string): string {
  const source = readFileSync(HELPER_SCRIPT, "utf8");
  const start = source.indexOf(`# --- ${name} `);
  if (start === -1) throw new Error(`the helper has no "${name}" section`);
  const end = source.indexOf("# --- ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

/** Lines the helper sets up before its sections, which the sections rely on. */
const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.DirectoryServices.Protocols",
  "$Sdp = 'System.DirectoryServices.Protocols'",
  "class HelperError : System.Exception { [string]$Code; HelperError([string]$code, [string]$message) : base($message) { $this.Code = $code } }",
];

/** Runs the named sections, then `body`, and returns the lines it printed. */
export async function runSections(names: string[], body: string[]): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "adslayer-helper-"));
  try {
    const file = join(dir, "section.ps1");
    await writeFile(file, [...PRELUDE, ...names.map(section), ...body].join("\n"));
    const { stdout } = await run(shell!, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", file]);
    return stdout.split(/\r?\n/).filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A JSON value as a PowerShell expression that parses it the way the helper's read loop does. */
export function fromJson(value: unknown): string {
  return `('${JSON.stringify(value).replace(/'/g, "''")}' | ConvertFrom-Json)`;
}
