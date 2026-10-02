import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION, USER_AGENT } from "../../src/core/version.js";

describe("version", () => {
  it("is read from package.json, so a release bump changes what the server reports", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

    expect(SERVER_VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(`adslayer/${pkg.version}`);
  });
});
