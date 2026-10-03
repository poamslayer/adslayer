/**
 * The helper's GptTmpl.inf reader, run in real PowerShell on a file saved the way Windows saves
 * it: UTF-16LE with a BOM. Names for SIDs need Windows, so this checks the parsing; the lab run
 * checks the names.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSections, shell } from "./run-section.js";

const INF = [
  "[Unicode]",
  "Unicode=yes",
  "[System Access]",
  "MinimumPasswordLength = 7",
  "NewAdministratorName = \"Administrator\"",
  "; a comment",
  "",
  "[Privilege Rights]",
  "SeInteractiveLogonRight = *S-1-5-32-544,*S-1-5-32-555",
  "SeServiceLogonRight=",
  "[Registry Values]",
  "MACHINE\\System\\CurrentControlSet\\Services\\LanManServer\\Parameters\\RequireSecuritySignature=4,1",
  "[Version]",
  "signature=\"$CHICAGO$\"",
  "Revision=1",
].join("\r\n");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "adslayer-gpttmpl-"));
  await writeFile(join(dir, "GptTmpl.inf"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(INF, "utf16le")]));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function read(path: string): Promise<{ sections: Record<string, Array<[string, string]>>; names: Record<string, string> }> {
  const [line] = await runSections(["ACLs", "Group Policy"], [
    `ConvertTo-Json -InputObject (Read-GptTmpl '${path}') -Compress -Depth 8`,
  ]);
  return JSON.parse(line);
}

describe.skipIf(!shell)("the helper's security template reader", () => {
  it("reads each section's lines in order, through the UTF-16 BOM, without comments or blank lines", async () => {
    const { sections } = await read(join(dir, "GptTmpl.inf"));
    expect(Object.keys(sections)).toEqual(["Unicode", "System Access", "Privilege Rights", "Registry Values", "Version"]);
    expect(sections["System Access"]).toEqual([["MinimumPasswordLength", "7"], ["NewAdministratorName", '"Administrator"']]);
    expect(sections["Privilege Rights"]).toEqual([["SeInteractiveLogonRight", "*S-1-5-32-544,*S-1-5-32-555"], ["SeServiceLogonRight", ""]]);
    expect(sections["Registry Values"]).toEqual([["MACHINE\\System\\CurrentControlSet\\Services\\LanManServer\\Parameters\\RequireSecuritySignature", "4,1"]]);
  }, 30_000);

  it("answers with no sections for a GPO that has no security template", async () => {
    expect(await read(join(dir, "missing.inf"))).toEqual({ sections: {}, names: {} });
  }, 30_000);

  it.runIf(process.platform === "win32")("names the built-in groups it finds", async () => {
    const { names } = await read(join(dir, "GptTmpl.inf"));
    expect(names["S-1-5-32-544"]).toBe("BUILTIN\\Administrators");
  }, 30_000);
});
