import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_DIR = join(process.cwd(), "src/core");

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("core architecture", () => {
  it("does not import sandbox drivers or transports", () => {
    const forbidden = [
      { dependency: "miniflare", pattern: /["']miniflare["']/ },
      { dependency: "transport", pattern: /["'](?:\.\.\/)+transport\// },
      { dependency: "cli", pattern: /["'](?:\.\.\/)+cli\// },
    ];
    const violations = typescriptFiles(CORE_DIR).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return forbidden
        .filter(({ pattern }) => pattern.test(source))
        .map(({ dependency }) => `${relative(process.cwd(), file)} imports ${dependency}`);
    });

    expect(violations, `Forbidden imports under src/core:\n${violations.join("\n")}`).toEqual([]);
  });
});
