/**
 * The helper's LDAP controls, run in real PowerShell. The binding checks control names first;
 * these tests pin the helper's own check and the OID it sends.
 */

import { describe, expect, it } from "vitest";
import { fromJson, runSections, shell } from "./run-section.js";

/** Adds the controls to a fresh request and prints each control's OID, or the error. */
function controlsOf(controls: unknown): Promise<string[]> {
  return runSections(["Controls"], [
    "$req = New-Object \"$Sdp.ModifyRequest\"",
    `try { Add-Controls $req ${fromJson(controls)}; foreach ($c in $req.Controls) { $c.Type } } catch { 'error:' + $_.Exception.Message }`,
  ]);
}

describe.skipIf(!shell)("the helper's controls", () => {
  it("sends showDeleted as the Show Deleted control", async () => {
    expect(await controlsOf({ showDeleted: true })).toEqual(["1.2.840.113556.1.4.417"]);
  }, 30_000);

  it("adds nothing when there are no controls", async () => {
    expect(await controlsOf(null)).toEqual([]);
  }, 30_000);

  it("refuses a control it does not know", async () => {
    expect(await controlsOf({ notify: true })).toEqual(["error:unknown control 'notify'"]);
  }, 30_000);

  it("refuses a control that is not true", async () => {
    expect(await controlsOf({ showDeleted: false })).toEqual(["error:control showDeleted must be true"]);
  }, 30_000);
});
