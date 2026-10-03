import { describe, expect, it } from "vitest";
import { describeAce, encodeAce, maskOf, rightsOf, type RawAce } from "../../../src/core/sandbox/acl.js";
import type { Catalogue } from "../../../src/core/catalogue/catalogue.js";

const RESET = "00299570-246d-11d0-a768-00aa006e0529";
const USER = "bf967aba-0de6-11d0-a285-00aa003049e2";
const MEMBER = "bf9679c0-0de6-11d0-a285-00aa003049e2";

const catalogue = {
  attributes: { member: { guid: MEMBER }, description: { guid: "bf967950-0de6-11d0-a285-00aa003049e2" }, twin: { guid: "11111111-1111-1111-1111-111111111111" } },
  classes: { user: { guid: USER }, organizationalUnit: { guid: "bf967aa5-0de6-11d0-a285-00aa003049e2" } },
  extendedRights: {
    "User-Force-Change-Password": { displayName: "Reset Password", guid: RESET },
    twin: { displayName: "Twin", guid: "22222222-2222-2222-2222-222222222222" },
  },
} as unknown as Catalogue;

const raw = (over: Partial<RawAce> = {}): RawAce => ({ type: "allow", sid: "S-1-5-21-1-2-3-1104", name: "LAB\\lab.delegated", mask: 0xf01ff, flags: 0, objectType: null, inheritedObjectType: null, ...over });

describe("ACL rights", () => {
  it.each([
    [0xf01ff, ["GenericAll"]],
    [0x20094, ["GenericRead"]],
    [0x10040, ["DeleteTree", "Delete"]],
    [0x30, ["ReadProperty", "WriteProperty"]],
    [0x100, ["ExtendedRight"]],
    [0xf01ff | 0x1000000, ["GenericAll", "AccessSystemSecurity"]],
    [0x200000, ["0x200000"]],
  ])("mask 0x%s reads as %j", (mask, rights) => {
    expect(rightsOf(mask)).toEqual(rights);
  });

  it("turns rights back into the same mask", () => {
    expect(maskOf(["Delete", "DeleteTree"])).toBe(0x10040);
    expect(maskOf(["GenericAll"])).toBe(0xf01ff);
    expect(maskOf(["ReadProperty", "WriteProperty"])).toBe(0x30);
  });

  it("rejects a right it does not know", () => {
    expect(() => maskOf(["FullControl"])).toThrow(/Unknown right "FullControl"/);
    expect(() => maskOf([])).toThrow(/at least one right/);
  });
});

describe("describeAce", () => {
  it("names the principal, rights and inheritance of a plain ACE", () => {
    expect(describeAce(raw({ flags: 0x02 }), catalogue)).toEqual({
      principal: { sid: "S-1-5-21-1-2-3-1104", name: "LAB\\lab.delegated" },
      type: "allow",
      rights: ["GenericAll"],
      inheritance: "All",
      inherited: false,
    });
  });

  it("names the extended right and the class of an object ACE, and marks it inherited", () => {
    expect(describeAce(raw({ mask: 0x100, flags: 0x02 | 0x08 | 0x10, objectType: RESET.toUpperCase(), inheritedObjectType: USER }), catalogue)).toMatchObject({
      rights: ["ExtendedRight"],
      objectType: "User-Force-Change-Password",
      inheritedObjectType: "user",
      inheritance: "Descendents",
      inherited: true,
    });
  });

  it("keeps a GUID the catalogue does not know", () => {
    expect(describeAce(raw({ objectType: "99999999-9999-9999-9999-999999999999" }), catalogue).objectType).toBe("99999999-9999-9999-9999-999999999999");
  });

  it.each([
    [0x00, "None"],
    [0x02, "All"],
    [0x0a, "Descendents"],
    [0x06, "SelfAndChildren"],
    [0x0e, "Children"],
  ])("reads ACE flags 0x%s as %s", (flags, inheritance) => {
    expect(describeAce(raw({ flags }), catalogue).inheritance).toBe(inheritance);
  });
});

describe("encodeAce", () => {
  it("turns a readable ACE into what the helper sends", () => {
    expect(encodeAce({ principal: "LAB\\GG-Helpdesk", type: "allow", rights: ["ExtendedRight"], objectType: "Reset Password", inheritedObjectType: "user", inheritance: "Descendents" }, catalogue)).toEqual({
      principal: "LAB\\GG-Helpdesk",
      type: "allow",
      mask: 0x100,
      inheritanceFlags: 1,
      propagationFlags: 2,
      objectType: RESET,
      inheritedObjectType: USER,
    });
  });

  it("defaults inheritance to None and leaves out object types it was not given", () => {
    expect(encodeAce({ principal: "S-1-1-0", type: "deny", rights: ["Delete", "DeleteTree"] }, catalogue)).toEqual({
      principal: "S-1-1-0", type: "deny", mask: 0x10040, inheritanceFlags: 0, propagationFlags: 0,
    });
  });

  it.each([
    ["All", 1, 0],
    ["Descendents", 1, 2],
    ["SelfAndChildren", 1, 1],
    ["Children", 1, 3],
  ])("encodes inheritance %s", (inheritance, inheritanceFlags, propagationFlags) => {
    expect(encodeAce({ principal: "S-1-1-0", type: "allow", rights: ["ReadProperty"], inheritance }, catalogue)).toMatchObject({ inheritanceFlags, propagationFlags });
  });

  it("resolves attribute names case-insensitively, and accepts a GUID as it is", () => {
    expect(encodeAce({ principal: "S-1-1-0", type: "allow", rights: ["WriteProperty"], objectType: "Member" }, catalogue).objectType).toBe(MEMBER);
    expect(encodeAce({ principal: "S-1-1-0", type: "allow", rights: ["WriteProperty"], objectType: MEMBER.toUpperCase() }, catalogue).objectType).toBe(MEMBER);
  });

  it.each([
    [{ objectType: "nope" }, /No attribute, class or extended right named "nope"/],
    [{ objectType: "twin" }, /"twin" names more than one/],
    [{ inheritedObjectType: "member" }, /No class named "member"/],
    [{ inheritance: "Everything" }, /inheritance must be/],
    [{ type: "audit" }, /type must be "allow" or "deny"/],
    [{ principal: "" }, /principal must be/],
  ])("rejects %j", (over, message) => {
    expect(() => encodeAce({ principal: "S-1-1-0", type: "allow", rights: ["ReadProperty"], ...over }, catalogue)).toThrow(message);
  });
});
