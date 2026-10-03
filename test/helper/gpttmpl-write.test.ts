/**
 * The helper's security template editing, run in real PowerShell. These are the text functions
 * behind gpo.grant, gpo.revoke and gpo.setSecurity: they change one key and leave every other line
 * as it was (ADR-0011, guardrail 1). The versioning and LDAP half runs only on the lab DC.
 */

import { describe, expect, it } from "vitest";
import { fromJson, runSections, shell } from "./run-section.js";

const TEMPLATE = [
  "[Unicode]",
  "Unicode=yes",
  "[System Access]",
  "MinimumPasswordLength = 7",
  "PasswordComplexity = 1",
  "[Privilege Rights]",
  "SeInteractiveLogonRight = *S-1-5-32-544,*S-1-5-32-555",
  "[Registry Values]",
  "MACHINE\\System\\X\\RequireSecuritySignature=4,0",
  "[Version]",
  'signature="$CHICAGO$"',
  "Revision=1",
  "",
].join("\r\n");

/** Runs one PowerShell expression over the helper's sections and returns its value. */
async function ps(expression: string): Promise<unknown> {
  const [line] = await runSections(["ACLs", "Group Policy", "Editing a security template"], [`ConvertTo-Json -InputObject (${expression}) -Compress`]);
  return line === undefined ? null : JSON.parse(line);
}
const text = (s: string) => fromJson(s);
const lines = (s: unknown) => String(s).split("\r\n");

describe.skipIf(!shell)("the helper's security template editing", () => {
  it("reads one key's value, or null", async () => {
    expect(await ps(`Get-InfValue ${text(TEMPLATE)} 'System Access' 'minimumpasswordlength'`)).toBe("7");
    expect(await ps(`Get-InfValue ${text(TEMPLATE)} 'System Access' 'LockoutBadCount'`)).toBeNull();
    expect(await ps(`Get-InfValue ${text(TEMPLATE)} 'Event Audit' 'AuditLogonEvents'`)).toBeNull();
  }, 30_000);

  it("replaces one value and leaves every other line exactly as it was", async () => {
    const out = lines(await ps(`Set-InfValue ${text(TEMPLATE)} 'System Access' 'MinimumPasswordLength' '14'`));
    const before = lines(TEMPLATE);
    expect(out[3]).toBe("MinimumPasswordLength = 14");
    expect(out.filter((_, i) => i !== 3)).toEqual(before.filter((_, i) => i !== 3));
  }, 30_000);

  it("adds a key at the end of its section, with the section's own separator", async () => {
    const out = lines(await ps(`Set-InfValue ${text(TEMPLATE)} 'Registry Values' 'MACHINE\\System\\X\\EnableSecuritySignature' '4,1'`));
    expect(out.slice(7, 11)).toEqual(["[Registry Values]", "MACHINE\\System\\X\\RequireSecuritySignature=4,0", "MACHINE\\System\\X\\EnableSecuritySignature=4,1", "[Version]"]);
    const sa = lines(await ps(`Set-InfValue ${text(TEMPLATE)} 'System Access' 'LockoutBadCount' '5'`));
    expect(sa.slice(2, 6)).toEqual(["[System Access]", "MinimumPasswordLength = 7", "PasswordComplexity = 1", "LockoutBadCount = 5"]);
  }, 30_000);

  it("adds a missing section, and starts a template for a GPO that has none", async () => {
    const added = lines(await ps(`Set-InfValue ${text(TEMPLATE)} 'Event Audit' 'AuditLogonEvents' '3'`));
    expect(added.slice(-3)).toEqual(["[Event Audit]", "AuditLogonEvents = 3", ""]);
    const fresh = lines(await ps(`Set-InfValue '' 'Privilege Rights' 'SeTimeZonePrivilege' '*S-1-5-32-555'`));
    expect(fresh).toEqual(["[Unicode]", "Unicode=yes", "[Version]", 'signature="$CHICAGO$"', "Revision=1", "[Privilege Rights]", "SeTimeZonePrivilege = *S-1-5-32-555", ""]);
  }, 30_000);

  it("removes a key's line when the value is null, and changes nothing when there is no such key", async () => {
    const out = lines(await ps(`Set-InfValue ${text(TEMPLATE)} 'Privilege Rights' 'SeInteractiveLogonRight' $null`));
    expect(out).toEqual(lines(TEMPLATE).filter((l) => !l.startsWith("SeInteractiveLogonRight")));
    expect(await ps(`Set-InfValue ${text(TEMPLATE)} 'Privilege Rights' 'SeBatchLogonRight' $null`)).toBe(TEMPLATE);
  }, 30_000);

  it.each([
    ["grants a SID to the end of a list", "*S-1-5-32-544,*S-1-5-32-555", "S-1-5-32-550", true, "*S-1-5-32-544,*S-1-5-32-555,*S-1-5-32-550"],
    ["leaves a list alone when the SID is already there", "*S-1-5-32-544,*S-1-5-32-555", "S-1-5-32-555", true, "*S-1-5-32-544,*S-1-5-32-555"],
    ["grants to an empty list", "", "S-1-5-32-555", true, "*S-1-5-32-555"],
    ["revokes a SID and keeps the order of the rest", "*S-1-5-32-544,*S-1-5-32-555,*S-1-5-32-550", "S-1-5-32-555", false, "*S-1-5-32-544,*S-1-5-32-550"],
    ["revokes the last SID to an empty list", "*S-1-5-32-555", "S-1-5-32-555", false, ""],
    ["leaves a list alone when revoking a SID that is not there", "*S-1-5-32-544", "S-1-5-32-555", false, "*S-1-5-32-544"],
  ])("%s", async (_name, current, sid, grant, expected) => {
    expect(await ps(`Edit-RightList '${current}' '${sid}' $${grant}`)).toBe(expected);
  }, 30_000);
});
