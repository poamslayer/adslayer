/**
 * The helper's ACL functions, run in real PowerShell against a descriptor built from SDDL, with no
 * domain. .NET's ACL classes run only on Windows, so this runs on the Windows CI runner and is
 * skipped elsewhere. The binding's half is tested on every OS in test/core/sandbox/acl.test.ts.
 */

import { describe, expect, it } from "vitest";
import { fromJson, runSections, shell } from "./run-section.js";

const RESET = "00299570-246d-11d0-a768-00aa006e0529";
const USER = "bf967aba-0de6-11d0-a285-00aa003049e2";
const protect = { principal: "S-1-1-0", type: "deny", mask: 0x10040, inheritanceFlags: 0, propagationFlags: 0 };
const reset = { principal: "S-1-5-32-548", type: "allow", mask: 0x100, inheritanceFlags: 1, propagationFlags: 2, objectType: RESET, inheritedObjectType: USER };

/** Builds a descriptor with one ACE for Authenticated Users, runs `body`, prints its value as JSON. */
async function withDescriptor(body: string): Promise<unknown> {
  const [line] = await runSections(["ACLs"], [
    "$sd = [System.Security.AccessControl.CommonSecurityDescriptor]::new($true, $true, 'O:S-1-5-32-544D:(A;;RPWP;;;S-1-5-11)')",
    `$value = & { ${body} }`,
    "ConvertTo-Json -InputObject $value -Compress -Depth 6",
  ]);
  return JSON.parse(line);
}

describe.skipIf(!shell || process.platform !== "win32")("the helper's ACLs", () => {
  it("reads an ACE as type, SID, name, mask and flags", async () => {
    expect(await withDescriptor("ConvertTo-RawAces $sd")).toEqual([
      { type: "allow", sid: "S-1-5-11", name: "NT AUTHORITY\\Authenticated Users", mask: 0x30, flags: 0, objectType: null, inheritedObjectType: null },
    ]);
  }, 30_000);

  it("adds a deny ACE that protects from deletion", async () => {
    const aces = (await withDescriptor(`Add-Ace $sd ${fromJson(protect)}; ConvertTo-RawAces $sd`)) as Array<Record<string, unknown>>;
    expect(aces).toContainEqual(expect.objectContaining({ type: "deny", sid: "S-1-1-0", mask: 0x10040, flags: 0 }));
  }, 30_000);

  it("adds an object ACE with its right, class and inheritance", async () => {
    const aces = (await withDescriptor(`Add-Ace $sd ${fromJson(reset)}; ConvertTo-RawAces $sd`)) as Array<Record<string, unknown>>;
    expect(aces).toContainEqual({ type: "allow", sid: "S-1-5-32-548", name: "BUILTIN\\Account Operators", mask: 0x100, flags: 0x0a, objectType: RESET, inheritedObjectType: USER });
  }, 30_000);

  it("removes an ACE it added, and says false when there is nothing to remove", async () => {
    expect(await withDescriptor(`Add-Ace $sd ${fromJson(reset)}; @((Remove-Ace $sd ${fromJson(reset)}), (Remove-Ace $sd ${fromJson(reset)}), $sd.DiscretionaryAcl.Count)`)).toEqual([true, false, 1]);
  }, 30_000);
});
