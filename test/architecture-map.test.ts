import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The LikeC4 map is the map of record (AGENTS.md). Every module under src/ and the helper must
// appear in it, and every code path in it must exist.
const MAP = readFileSync(join(process.cwd(), "docs/architecture/adslayer.c4"), "utf8");
const CODE_PATHS = [...MAP.matchAll(/code '([^']+)'/g)].map((match) => match[1]);

// Shared types and constants, too small to be a box of their own.
const NOT_IN_MAP = new Set([
  "src/core/types.ts",
  "src/core/version.ts",
  "src/core/sandbox/sandbox.ts",
  "src/core/sandbox/binding-types.ts",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relative(process.cwd(), path).split("\\").join("/")] : [];
  });
}

describe("architecture map", () => {
  it("points only at files that exist", () => {
    const missing = CODE_PATHS.filter((path) => !existsSync(join(process.cwd(), path)));
    expect(missing).toEqual([]);
  });

  it("has an element for every module and the helper", () => {
    const expected = [...sourceFiles(join(process.cwd(), "src")), "helper/adslayer-helper.ps1"];
    const unmapped = expected.filter((path) => !NOT_IN_MAP.has(path) && !CODE_PATHS.includes(path));
    expect(unmapped, "Add these to docs/architecture/adslayer.c4, or to NOT_IN_MAP if they are shared support code").toEqual([]);
  });
});
