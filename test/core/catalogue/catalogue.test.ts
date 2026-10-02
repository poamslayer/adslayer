import { describe, expect, it, vi } from "vitest";
import { CatalogueCache, readCatalogue, syntaxName } from "../../../src/core/catalogue/catalogue.js";
import type { LdapBackend } from "../../../src/core/ldap/backend.js";

const SCHEMA = "CN=Schema,CN=Configuration,DC=lab,DC=test";
const CONFIG = "CN=Configuration,DC=lab,DC=test";
const e = (attrs: Record<string, string | string[]>) => ({
  dn: "x",
  attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])),
});

const attributes = [
  e({ lDAPDisplayName: "member", attributeID: "2.5.4.31", attributeSyntax: "2.5.5.1", oMSyntax: "127", isSingleValued: "FALSE", searchFlags: "0", linkID: "2", schemaIDGUID: "bf9679c0-0de6-11d0-a285-00aa003049e2" }),
  e({ lDAPDisplayName: "msLAPS-Password", attributeID: "1.2.3", attributeSyntax: "2.5.5.12", oMSyntax: "64", isSingleValued: "TRUE", searchFlags: "640" }),
  e({ lDAPDisplayName: "telephoneNumber", attributeID: "2.5.4.20", attributeSyntax: "2.5.5.12", oMSyntax: "64", isSingleValued: "TRUE", searchFlags: "1", rangeLower: "1", rangeUpper: "64", attributeSecurityGUID: "77b5b886-944a-11d1-aebd-0000f80367c1" }),
  e({ lDAPDisplayName: "cn", attributeID: "2.5.4.3", attributeSyntax: "2.5.5.12", oMSyntax: "64", isSingleValued: "TRUE", searchFlags: "1", systemOnly: "FALSE" }),
];
const classes = [
  e({ lDAPDisplayName: "top", governsID: "2.5.6.0", objectClassCategory: "2", subClassOf: "top", systemMustContain: ["objectClass"], systemMayContain: ["cn"], schemaIDGUID: "bf967ab7-0de6-11d0-a285-00aa003049e2" }),
  e({ lDAPDisplayName: "person", governsID: "2.5.6.6", objectClassCategory: "0", subClassOf: "top", systemMayContain: ["telephoneNumber"] }),
  e({ lDAPDisplayName: "mailRecipient", governsID: "1.2.840.113556.1.3.46", objectClassCategory: "3", subClassOf: "top", mayContain: ["telephoneNumber"] }),
  e({ lDAPDisplayName: "user", governsID: "1.2.840.113556.1.5.9", objectClassCategory: "1", subClassOf: "person", systemAuxiliaryClass: ["mailRecipient"], systemMustContain: ["cn"], schemaIDGUID: "bf967aba-0de6-11d0-a285-00aa003049e2" }),
];
const rights = [
  e({ cn: "User-Force-Change-Password", displayName: "Reset Password", rightsGuid: "00299570-246d-11d0-a768-00aa006e0529", validAccesses: "256", appliesTo: ["bf967aba-0de6-11d0-a285-00aa003049e2", "4828cc14-1437-45bc-9b07-ad6f015e5f28"] }),
  e({ cn: "Personal-Information", displayName: "Personal Information", rightsGuid: "77b5b886-944a-11d1-aebd-0000f80367c1", validAccesses: "48" }),
];

const POLICIES = {
  source: "\\\\lab.test\\SYSVOL\\lab.test\\Policies\\PolicyDefinitions",
  policies: [
    { name: "NoLockScreen", file: "ControlPanelDisplay", displayName: "Do not display the lock screen", class: "Machine", key: "Software\\Policies\\Microsoft\\Windows\\Personalization", valueName: "NoLockScreen", category: "Personalization", elements: [] },
    { name: "Wallpaper", file: "Desktop", displayName: "Desktop Wallpaper", class: "User", key: "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", valueName: null, category: "Desktop", elements: [{ type: "text", id: "WallpaperName", valueName: "Wallpaper", key: null }] },
  ],
};

function backend(policies: unknown = POLICIES): LdapBackend & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(async (_domain: string, op: string, args: Record<string, unknown>) => {
      if (op === "policydefinitions") {
        if (policies instanceof Error) throw policies;
        return policies;
      }
      if (op === "rootdse") return { schemaNamingContext: [SCHEMA], configurationNamingContext: [CONFIG], dnsHostName: ["dc01.lab.test"], supportedControl: ["1.2.840.113556.1.4.319", "9.9.9"], forestFunctionality: ["10"], domainFunctionality: ["10"] };
      if (args.filter === "(objectClass=attributeSchema)") return { entries: attributes, more: false };
      if (args.filter === "(objectClass=classSchema)") return { entries: classes, more: false };
      if (args.base === `CN=Extended-Rights,${CONFIG}`) return { entries: rights, more: false };
      throw new Error(`unexpected ${op} ${JSON.stringify(args)}`);
    }),
  };
}

describe("readCatalogue", () => {
  it("reads attributes with syntax, single, confidential, indexed, links, range and property set", async () => {
    const c = await readCatalogue(backend(), "lab.test", () => new Date("2026-10-02T00:00:00Z"));
    expect(c).toMatchObject({ domain: "lab.test", readAt: "2026-10-02T00:00:00.000Z", dc: "dc01.lab.test", schemaNamingContext: SCHEMA, forestFunctionality: 10 });
    expect(c.attributes.member).toEqual({ oid: "2.5.4.31", guid: "bf9679c0-0de6-11d0-a285-00aa003049e2", syntax: "DN", single: false, linkID: 2 });
    expect(c.attributes["msLAPS-Password"]).toMatchObject({ syntax: "UnicodeString", single: true, confidential: true });
    expect(c.attributes["msLAPS-Password"].indexed).toBeUndefined();
    expect(c.attributes.telephoneNumber).toMatchObject({ indexed: true, range: [1, 64], propertySet: "Personal-Information" });
  });

  it("gives each class its inherited and auxiliary attributes, with must taking precedence", async () => {
    const c = await readCatalogue(backend(), "lab.test");
    expect(c.classes.user).toMatchObject({ kind: "structural", parent: "person", auxiliary: ["mailRecipient"] });
    expect(c.classes.user.must).toEqual(["cn", "objectClass"]);
    expect(c.classes.user.may).toEqual(["telephoneNumber"]);
    expect(c.classes.top.kind).toBe("abstract");
    expect(c.classes.person.kind).toBe("88");
    expect(c.classes.mailRecipient.kind).toBe("auxiliary");
  });

  it("names controls it knows and the classes a right applies to", async () => {
    const c = await readCatalogue(backend(), "lab.test");
    expect(c.controls).toEqual([{ oid: "1.2.840.113556.1.4.319", name: "Paged results" }, { oid: "9.9.9" }]);
    expect(c.extendedRights["User-Force-Change-Password"]).toEqual({
      displayName: "Reset Password",
      guid: "00299570-246d-11d0-a768-00aa006e0529",
      kind: "control",
      appliesTo: ["user", "4828cc14-1437-45bc-9b07-ad6f015e5f28"],
    });
    expect(c.extendedRights["Personal-Information"].kind).toBe("propertySet");
  });
});

describe("policy definitions in the catalogue", () => {
  it("includes the ADMX policies, without the null fields PowerShell sends", async () => {
    const c = await readCatalogue(backend(), "lab.test");
    expect(c.policiesSource).toContain("PolicyDefinitions");
    expect(c.policies[0]).toMatchObject({ name: "NoLockScreen", class: "Machine", valueName: "NoLockScreen" });
    expect(c.policies[1]).toEqual({
      name: "Wallpaper",
      displayName: "Desktop Wallpaper",
      class: "User",
      key: "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
      category: "Desktop",
      file: "Desktop",
      elements: [{ type: "text", id: "WallpaperName", valueName: "Wallpaper" }],
    });
  });

  it("still returns the schema when the policy files cannot be read", async () => {
    const c = await readCatalogue(backend(new Error("access denied")), "lab.test");
    expect(c.policies).toEqual([]);
    expect(c.policiesError).toBe("access denied");
    expect(c.attributes.member).toBeDefined();
  });
});

describe("syntaxName", () => {
  it.each([
    ["2.5.5.1", "127", "DN"],
    ["2.5.5.5", "22", "IA5String"],
    ["2.5.5.9", "10", "Enumeration"],
    ["2.5.5.9", "2", "Integer"],
    ["2.5.5.16", "65", "LargeInteger"],
    ["2.5.5.17", "4", "SID"],
    ["9.9", "1", "9.9"],
  ])("%s/%s is %s", (syntax, om, name) => expect(syntaxName(syntax, om)).toBe(name));
});

describe("CatalogueCache", () => {
  it("reads each domain once, again on refresh, and again after a failed read", async () => {
    let n = 0;
    const read = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("DC down");
      return { domain: "lab.test" } as never;
    });
    const cache = new CatalogueCache({ call: async () => null }, read);
    await expect(cache.get("lab.test")).rejects.toThrow("DC down");
    await cache.get("LAB.test");
    await cache.get("lab.test");
    expect(read).toHaveBeenCalledTimes(2);
    await cache.get("lab.test", true);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
