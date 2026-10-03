/**
 * The helper's value conversion, run in real PowerShell. A `{ base64 }` value has to reach
 * System.DirectoryServices.Protocols as a byte[]: PowerShell unrolls an array a function returns,
 * and an unrolled one is sent as a string of numbers, which is how a password reset through
 * unicodePwd once failed with UnwillingToPerform.
 */

import { describe, expect, it } from "vitest";
import { fromJson, runSections, shell } from "./run-section.js";

/** Runs ConvertFrom-JsonValues on a JSON value and describes each converted value. */
function convert(json: unknown): Promise<string[]> {
  return runSections(["Values"], [
    `$r = ConvertFrom-JsonValues ${fromJson(json)}`,
    "foreach ($v in $r) { if ($v -is [byte[]]) { 'bytes:' + [Convert]::ToBase64String($v) } else { $v.GetType().Name + ':' + $v } }",
  ]);
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
