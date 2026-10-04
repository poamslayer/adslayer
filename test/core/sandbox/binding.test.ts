import { describe, expect, it, vi } from "vitest";
import { LdapError, type LdapBackend } from "../../../src/core/ldap/backend.js";
import { DEFAULT_ATTRIBUTES, makeBinding } from "../../../src/core/sandbox/binding.js";
import type { Connection } from "../../../src/core/types.js";

const read: Connection = { alias: "lab", domain: "lab.adslayer.test", mode: "read", addedAt: "x" };
const write: Connection = { ...read, alias: "lab-w", mode: "write" };
const legacy: Connection = { alias: "old", domain: "lab.adslayer.test", addedAt: "x" };

function backend(answer: (op: string, args: Record<string, unknown>) => unknown = () => ({ entries: [], more: false })) {
  return { call: vi.fn(async (_domain: string, op: string, args: Record<string, unknown>) => answer(op, args)) } satisfies LdapBackend;
}

describe("the ad binding", () => {
  it("sends a search to the connection's domain with the default attributes", async () => {
    const b = backend();
    const { handle } = makeBinding({ backend: b, connection: read });
    await handle("search", [{ filter: "(cn=a)" }]);
    expect(b.call).toHaveBeenCalledWith("lab.adslayer.test", "search", { filter: "(cn=a)", scope: "sub", attributes: DEFAULT_ATTRIBUTES });
  });

  it("passes base, scope, attributes and max through", async () => {
    const b = backend();
    await makeBinding({ backend: b, connection: read }).handle("search", [{ base: "OU=Lab,DC=x", scope: "one", attributes: ["member"], max: 5 }]);
    expect(b.call.mock.calls[0][2]).toEqual({ base: "OU=Lab,DC=x", scope: "one", attributes: ["member"], max: 5 });
  });

  it("get is a base search that answers null for an object that does not exist", async () => {
    const b = backend(() => {
      throw new LdapError("NoSuchObject", "The object does not exist.");
    });
    expect(await makeBinding({ backend: b, connection: read }).handle("get", ["CN=nope,DC=x"])).toBeNull();
    expect(b.call.mock.calls[0][2]).toEqual({ base: "CN=nope,DC=x", scope: "base", attributes: DEFAULT_ATTRIBUTES, max: 1 });
  });

  it("get returns the one entry", async () => {
    const entry = { dn: "CN=a,DC=x", attributes: { name: ["a"] } };
    expect(await makeBinding({ backend: backend(() => ({ entries: [entry], more: false })), connection: read }).handle("get", ["CN=a,DC=x"])).toEqual(entry);
  });

  it.each([
    ["add", ["CN=a,DC=x", { objectClass: "contact" }]],
    ["modify", ["CN=a,DC=x", [{ op: "replace", attribute: "description", values: "x" }]]],
    ["delete", ["CN=a,DC=x"]],
    ["move", ["CN=a,DC=x", { newParent: "OU=b,DC=x" }]],
  ])("a read connection refuses %s before anything reaches the helper (ADR-0004)", async (op, args) => {
    const b = backend();
    const { handle, calls } = makeBinding({ backend: b, connection: read });
    await expect(handle(op, args)).rejects.toThrow(/added in read mode, so it cannot/);
    expect(b.call).not.toHaveBeenCalled();
    expect(calls()).toEqual([]);
  });

  it("a connection with no stored mode is read", async () => {
    const b = backend();
    await expect(makeBinding({ backend: b, connection: legacy }).handle("delete", ["CN=a,DC=x"])).rejects.toThrow(/read mode/);
    expect(b.call).not.toHaveBeenCalled();
  });

  it("a write connection sends writes, shaped for the helper", async () => {
    const b = backend(() => ({ dn: "CN=a,DC=x" }));
    const { handle } = makeBinding({ backend: b, connection: write });
    await handle("add", ["CN=a,DC=x", { objectClass: ["top", "contact"] }]);
    await handle("modify", ["CN=a,DC=x", [{ op: "delete", attribute: "description" }]]);
    await handle("move", ["CN=a,DC=x", { newName: "CN=b" }]);
    await handle("delete", ["CN=b,DC=x", { tree: true }]);
    expect(b.call.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["add", { dn: "CN=a,DC=x", attributes: { objectClass: ["top", "contact"] } }],
      ["modify", { dn: "CN=a,DC=x", changes: [{ op: "delete", attribute: "description" }] }],
      ["move", { dn: "CN=a,DC=x", newName: "CN=b" }],
      ["delete", { dn: "CN=b,DC=x", tree: true }],
    ]);
  });

  it("puts the helper's error code in the message the script sees, and records it", async () => {
    const b = backend(() => {
      throw new LdapError("InsufficientAccessRights", "The user has insufficient access rights.");
    });
    const { handle, calls } = makeBinding({ backend: b, connection: write });
    await expect(handle("modify", ["CN=a,DC=x", [{ op: "replace", attribute: "d", values: "x" }]])).rejects.toThrow(
      "InsufficientAccessRights: The user has insufficient access rights.",
    );
    expect(calls()).toEqual([{ op: "modify", target: "CN=a,DC=x", ok: false, code: "InsufficientAccessRights", ms: expect.any(Number) }]);
  });

  it("records each call", async () => {
    const { handle, calls } = makeBinding({ backend: backend(), connection: read });
    await handle("search", [{ base: "OU=Lab,DC=x" }]);
    await handle("whoami", []);
    expect(calls().map(({ op, target, ok }) => ({ op, target, ok }))).toEqual([
      { op: "search", target: "OU=Lab,DC=x", ok: true },
      { op: "whoami", target: "", ok: true },
    ]);
  });

  it("passes showDeleted through on get, search and modify", async () => {
    const b = backend(() => ({ entries: [], more: false }));
    const { handle } = makeBinding({ backend: b, connection: write });
    const controls = { showDeleted: true };
    await handle("get", ["CN=a\\0ADEL:x,CN=Deleted Objects,DC=x", ["isDeleted"], { controls }]);
    await handle("search", [{ base: "CN=Deleted Objects,DC=x", filter: "(isDeleted=TRUE)", controls }]);
    await handle("modify", ["CN=a\\0ADEL:x,CN=Deleted Objects,DC=x", [{ op: "delete", attribute: "isDeleted" }, { op: "replace", attribute: "distinguishedName", values: "CN=a,OU=Lab,DC=x" }], { controls }]);
    expect(b.call.mock.calls.map((c) => c[2].controls)).toEqual([controls, controls, controls]);
  });

  it("sends no controls when none are asked for", async () => {
    const b = backend(() => ({ dn: "CN=a,DC=x" }));
    await makeBinding({ backend: b, connection: write }).handle("modify", ["CN=a,DC=x", [{ op: "delete", attribute: "description" }]]);
    expect(b.call.mock.calls[0][2]).not.toHaveProperty("controls");
  });

  it("lets a read connection search deleted objects, and refuses the restore (ADR-0004)", async () => {
    const b = backend();
    const { handle } = makeBinding({ backend: b, connection: read });
    await handle("search", [{ base: "CN=Deleted Objects,DC=x", controls: { showDeleted: true } }]);
    await expect(handle("modify", ["CN=a,DC=x", [{ op: "delete", attribute: "isDeleted" }], { controls: { showDeleted: true } }])).rejects.toThrow(/read mode/);
    expect(b.call).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["search", [{ controls: { notify: true } }], /Unknown control "notify"/],
    ["search", [{ controls: { showDeleted: "yes" } }], /showDeleted must be true/],
    ["search", [{ controls: ["showDeleted"] }], /controls must be an object/],
    ["get", ["CN=a,DC=x", undefined, { controls: { tree: true } }], /Unknown control "tree"/],
    ["modify", ["CN=a,DC=x", [{ op: "delete", attribute: "d" }], { controls: { x: true } }], /Unknown control "x"/],
  ])("rejects a bad controls option on %s without sending it", async (op, args, message) => {
    const b = backend();
    await expect(makeBinding({ backend: b, connection: write }).handle(op, args)).rejects.toThrow(message);
    expect(b.call).not.toHaveBeenCalled();
  });

  it("stops a run at the call cap", async () => {
    const { handle } = makeBinding({ backend: backend(), connection: read, maxCalls: 2 });
    await handle("whoami", []);
    await handle("whoami", []);
    await expect(handle("whoami", [])).rejects.toThrow("Call limit of 2 reached");
  });

  it.each([
    ["get", [42]],
    ["search", [{ scope: "everything" }]],
    ["search", [{ attributes: "name" }]],
    ["search", [{ max: 0 }]],
    ["modify", ["CN=a", []]],
    ["move", ["CN=a", {}]],
    ["frobnicate", []],
  ])("rejects a malformed %s call without sending it", async (op, args) => {
    const b = backend();
    await expect(makeBinding({ backend: b, connection: write }).handle(op, args)).rejects.toThrow();
    expect(b.call).not.toHaveBeenCalled();
  });
});

describe("the gpo binding", () => {
  it.each([
    ["gpo.create", ["Lab Test"]],
    ["gpo.delete", ["Lab Test"]],
    ["gpo.link", ["Lab Test", "OU=Lab,DC=x"]],
    ["gpo.unlink", ["Lab Test", "OU=Lab,DC=x"]],
    ["gpo.set", ["Lab Test", { key: "HKLM\\Software\\Policies\\X", valueName: "Y", type: "DWord", value: 1 }]],
    ["gpo.remove", ["Lab Test", "HKLM\\Software\\Policies\\X"]],
  ])("a read connection refuses %s before anything reaches the helper", async (op, args) => {
    const b = backend();
    await expect(makeBinding({ backend: b, connection: read }).handle(op, args)).rejects.toThrow(/read mode/);
    expect(b.call).not.toHaveBeenCalled();
  });

  it("lets a read connection list, get and back up, which change nothing in the domain", async () => {
    const b = backend(() => ({}));
    const { handle } = makeBinding({ backend: b, connection: read });
    await handle("gpo.list", []);
    await handle("gpo.get", ["Lab Baseline"]);
    await handle("gpo.backup", ["Lab Baseline", "C:\\Backups"]);
    expect(b.call.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["gpo.list", {}],
      ["gpo.get", { gpo: "Lab Baseline" }],
      ["gpo.backup", { gpo: "Lab Baseline", path: "C:\\Backups" }],
    ]);
  });

  it("gpo.get turns the helper's security template into securitySettings", async () => {
    const b = backend(() => ({
      id: "x", name: "Default Domain Policy", links: [], computerSettings: [], userSettings: [],
      securityTemplate: { sections: { "System Access": [["MinimumPasswordLength", "7"]], "Privilege Rights": [["SeBatchLogonRight", "*S-1-5-32-544"]] }, names: { "S-1-5-32-544": "BUILTIN\\Administrators" } },
    }));
    const g = (await makeBinding({ backend: b, connection: read }).handle("gpo.get", ["Default Domain Policy"])) as Record<string, unknown>;
    expect(g).not.toHaveProperty("securityTemplate");
    expect(g.securitySettings).toMatchObject({
      systemAccess: { MinimumPasswordLength: 7 },
      privilegeRights: { SeBatchLogonRight: [{ sid: "S-1-5-32-544", name: "BUILTIN\\Administrators" }] },
    });
  });

  it("shapes writes for the helper on a write connection", async () => {
    const b = backend(() => ({}));
    const { handle } = makeBinding({ backend: b, connection: write });
    await handle("gpo.create", ["Lab Test", { comment: "made by a test" }]);
    await handle("gpo.link", ["Lab Test", "OU=Lab,DC=x", { enforced: true, order: 1 }]);
    await handle("gpo.set", ["Lab Test", { key: "HKCU\\Software\\Policies\\X", valueName: "Y", type: "String", value: "z" }]);
    await handle("gpo.remove", ["Lab Test", "HKCU\\Software\\Policies\\X", "Y"]);
    expect(b.call.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["gpo.create", { name: "Lab Test", comment: "made by a test" }],
      ["gpo.link", { gpo: "Lab Test", target: "OU=Lab,DC=x", enforced: true, order: 1 }],
      ["gpo.set", { gpo: "Lab Test", key: "HKCU\\Software\\Policies\\X", valueName: "Y", type: "String", value: "z" }],
      ["gpo.remove", { gpo: "Lab Test", key: "HKCU\\Software\\Policies\\X", valueName: "Y" }],
    ]);
  });

  it.each([
    [["Lab", { key: "Software\\Policies\\X", valueName: "Y", type: "DWord", value: 1 }], /HKLM/],
    [["Lab", { key: "HKLM\\X", valueName: "Y", type: "Binary", value: 1 }], /type must be/],
    [["Lab", { key: "HKLM\\X", valueName: "Y", type: "DWord" }], /needs a value/],
  ])("rejects a malformed gpo.set %#", async (args, message) => {
    const b = backend();
    await expect(makeBinding({ backend: b, connection: write }).handle("gpo.set", args)).rejects.toThrow(message);
    expect(b.call).not.toHaveBeenCalled();
  });
});

describe("the ACL methods", () => {
  const RESET = "00299570-246d-11d0-a768-00aa006e0529";
  const USER = "bf967aba-0de6-11d0-a285-00aa003049e2";
  const catalogue = { attributes: {}, classes: { user: { guid: USER } }, extendedRights: { "User-Force-Change-Password": { displayName: "Reset Password", guid: RESET } } };
  const catalogues = { get: vi.fn(async () => catalogue as never) };
  const reset = { principal: "LAB\\GG-Helpdesk", type: "allow", rights: ["ExtendedRight"], objectType: "User-Force-Change-Password", inheritedObjectType: "user", inheritance: "Descendents" };

  it("getAcl reads the DACL on a read connection and names what it can", async () => {
    const b = backend(() => ({
      owner: { sid: "S-1-5-21-1-2-3-512", name: "LAB\\Domain Admins" },
      protected: false,
      aces: [{ type: "allow", sid: "S-1-5-21-1-2-3-1104", name: "LAB\\lab.delegated", mask: 0x100, flags: 0x1a, objectType: RESET, inheritedObjectType: USER }],
    }));
    const acl = await makeBinding({ backend: b, connection: read, catalogues }).handle("getAcl", ["OU=Lab,DC=x"]);
    expect(b.call).toHaveBeenCalledWith("lab.adslayer.test", "acl.get", { dn: "OU=Lab,DC=x" });
    expect(acl).toEqual({
      dn: "OU=Lab,DC=x",
      owner: { sid: "S-1-5-21-1-2-3-512", name: "LAB\\Domain Admins" },
      protected: false,
      aces: [{ principal: { sid: "S-1-5-21-1-2-3-1104", name: "LAB\\lab.delegated" }, type: "allow", rights: ["ExtendedRight"], objectType: "User-Force-Change-Password", inheritedObjectType: "user", inheritance: "Descendents", inherited: true }],
    });
  });

  it("getAcl still answers, with GUIDs, when the catalogue cannot be read", async () => {
    const b = backend(() => ({ owner: { sid: "S-1-1-0", name: null }, protected: false, aces: [{ type: "allow", sid: "S-1-1-0", name: null, mask: 0x100, flags: 0, objectType: RESET, inheritedObjectType: null }] }));
    const failing = { get: vi.fn(async () => { throw new Error("no catalogue"); }) };
    const acl = (await makeBinding({ backend: b, connection: read, catalogues: failing }).handle("getAcl", ["OU=Lab,DC=x"])) as { aces: Array<{ objectType: string }> };
    expect(acl.aces[0].objectType).toBe(RESET);
  });

  it.each([["addAce"], ["removeAce"]])("a read connection refuses %s before anything is sent (ADR-0004)", async (op) => {
    const b = backend();
    await expect(makeBinding({ backend: b, connection: read, catalogues }).handle(op, ["OU=Lab,DC=x", reset])).rejects.toThrow(/read mode/);
    expect(b.call).not.toHaveBeenCalled();
  });

  it("addAce and removeAce send the ACE in the helper's terms", async () => {
    const b = backend((op) => (op === "acl.remove" ? { dn: "OU=Lab,DC=x", removed: true } : { dn: "OU=Lab,DC=x" }));
    const { handle, calls } = makeBinding({ backend: b, connection: write, catalogues });
    await handle("addAce", ["OU=Lab,DC=x", reset]);
    expect(await handle("removeAce", ["OU=Lab,DC=x", reset])).toEqual({ dn: "OU=Lab,DC=x", removed: true });
    const sent = { dn: "OU=Lab,DC=x", ace: { principal: "LAB\\GG-Helpdesk", type: "allow", mask: 0x100, inheritanceFlags: 1, propagationFlags: 2, objectType: RESET, inheritedObjectType: USER } };
    expect(b.call.mock.calls.map((c) => [c[1], c[2]])).toEqual([["acl.add", sent], ["acl.remove", sent]]);
    expect(calls().map((c) => [c.op, c.target])).toEqual([["acl.add", "OU=Lab,DC=x"], ["acl.remove", "OU=Lab,DC=x"]]);
  });

  it("does not read the catalogue for an ACE with no names to look up", async () => {
    const lazy = { get: vi.fn(async () => catalogue as never) };
    const b = backend(() => ({ dn: "OU=Lab,DC=x" }));
    await makeBinding({ backend: b, connection: write, catalogues: lazy }).handle("addAce", ["OU=Lab,DC=x", { principal: "S-1-1-0", type: "deny", rights: ["Delete", "DeleteTree"] }]);
    expect(lazy.get).not.toHaveBeenCalled();
    expect(b.call.mock.calls[0][2]).toEqual({ dn: "OU=Lab,DC=x", ace: { principal: "S-1-1-0", type: "deny", mask: 0x10040, inheritanceFlags: 0, propagationFlags: 0 } });
  });

  it("takes an ACE back exactly as getAcl returned it", async () => {
    const b = backend(() => ({ dn: "OU=Lab,DC=x", removed: true }));
    const fromGetAcl = { principal: { sid: "S-1-1-0", name: "Everyone" }, type: "deny", rights: ["DeleteTree", "Delete"], inheritance: "None", inherited: false };
    await makeBinding({ backend: b, connection: write, catalogues }).handle("removeAce", ["OU=Lab,DC=x", fromGetAcl]);
    expect(b.call.mock.calls[0][2]).toMatchObject({ ace: { principal: "S-1-1-0", mask: 0x10040 } });
  });

  it("refuses to remove an inherited ACE, which lives on a parent", async () => {
    const b = backend();
    await expect(makeBinding({ backend: b, connection: write, catalogues }).handle("removeAce", ["OU=Lab,DC=x", { ...reset, inherited: true }])).rejects.toThrow(/inherited/);
    expect(b.call).not.toHaveBeenCalled();
  });
});

describe("the GPO security write methods (ADR-0011)", () => {
  const rightAnswer = { id: "g1", right: "SeServiceLogonRight", sid: "S-1-5-21-1-2-3-1150", changed: true, defined: "new", before: [], after: ["*S-1-5-21-1-2-3-1150"], names: { "S-1-5-21-1-2-3-1150": "LAB\\svc-web" } };

  it.each([
    ["gpo.grant", ["Servers", "SeServiceLogonRight", "LAB\\svc-web"]],
    ["gpo.revoke", ["Servers", "SeServiceLogonRight", "LAB\\svc-web"]],
    ["gpo.setSecurity", ["Servers", "System Access", "MinimumPasswordLength", 14]],
  ])("a read connection refuses %s before anything is sent (ADR-0004)", async (op, args) => {
    const b = backend();
    await expect(makeBinding({ backend: b, connection: read }).handle(op, args)).rejects.toThrow(/read mode/);
    expect(b.call).not.toHaveBeenCalled();
  });

  it("grant sends the right and principal, and names the principals in the answer", async () => {
    const b = backend(() => rightAnswer);
    const out = await makeBinding({ backend: b, connection: write }).handle("gpo.grant", ["Servers", "SeServiceLogonRight", "LAB\\svc-web"]);
    expect(b.call.mock.calls[0][1]).toBe("gpo.grant");
    expect(b.call.mock.calls[0][2]).toEqual({ gpo: "Servers", right: "SeServiceLogonRight", principal: "LAB\\svc-web" });
    expect(out).toEqual({
      id: "g1", right: "SeServiceLogonRight", principal: { sid: "S-1-5-21-1-2-3-1150", name: "LAB\\svc-web" },
      changed: true, defined: "new", before: [], after: [{ sid: "S-1-5-21-1-2-3-1150", name: "LAB\\svc-web" }],
    });
  });

  it.each([
    [["System Access", "MinimumPasswordLength", 14], "14"],
    [["System Access", "NewAdministratorName", "LabAdmin"], '"LabAdmin"'],
    [["Registry Values", "MACHINE\\System\\X\\RequireSecuritySignature", { type: 4, value: 1 }], "4,1"],
    [["Registry Values", "MACHINE\\Software\\X\\LegalNoticeCaption", { type: 1, value: "Notice" }], '1,"Notice"'],
    [["Registry Values", "MACHINE\\System\\X\\Machine", { type: 7, value: ["System\\A", "System\\B"] }], "7,System\\A,System\\B"],
  ])("setSecurity %j sends the value as the template writes it", async (args, encoded) => {
    const b = backend((_op, a) => ({ id: "g1", section: a.section, key: a.key, changed: true, before: null, after: a.value }));
    await makeBinding({ backend: b, connection: write }).handle("gpo.setSecurity", ["Servers", ...args]);
    expect(b.call.mock.calls[0][2]).toEqual({ gpo: "Servers", section: args[0], key: args[1], value: encoded });
  });

  it("setSecurity answers with the old and new values in readable form", async () => {
    const b = backend(() => ({ id: "g1", section: "Registry Values", key: "MACHINE\\X", changed: true, before: "4,0", after: "4,1" }));
    expect(await makeBinding({ backend: b, connection: write }).handle("gpo.setSecurity", ["Servers", "Registry Values", "MACHINE\\X", { type: 4, value: 1 }])).toEqual({
      id: "g1", section: "Registry Values", key: "MACHINE\\X", changed: true, before: { type: 4, value: 0 }, after: { type: 4, value: 1 },
    });
  });

  it.each([
    ["gpo.grant", ["Servers", "Log on as a service", "LAB\\x"], /right must be a user right/],
    ["gpo.grant", ["Servers", "SeServiceLogonRight", ""], /principal must be/],
    ["gpo.setSecurity", ["Servers", "Event Audit", "AuditLogonEvents", 3], /section must be/],
    ["gpo.setSecurity", ["Servers", "System Access", "MinPasswordLength", 14], /Unknown System Access key "MinPasswordLength"/],
    ["gpo.setSecurity", ["Servers", "System Access", "MinimumPasswordLength", 1.5], /whole number/],
    ["gpo.setSecurity", ["Servers", "System Access", "MinimumPasswordLength", "14"], /whole number/],
    ["gpo.setSecurity", ["Servers", "Registry Values", "SOFTWARE\\X", { type: 4, value: 1 }], /MACHINE\\/],
    ["gpo.setSecurity", ["Servers", "Registry Values", "MACHINE\\X", { type: 3, value: "00" }], /type must be 1, 2, 4 or 7/],
    ["gpo.setSecurity", ["Servers", "Registry Values", "MACHINE\\X", { type: 7, value: ["a,b"] }], /comma/],
    ["gpo.setSecurity", ["Servers", "Registry Values", "MACHINE\\X", { type: 1, value: 'say "hi"' }], /quote/],
  ])("rejects a malformed %s %j without sending it", async (op, args, message) => {
    const b = backend();
    await expect(makeBinding({ backend: b, connection: write }).handle(op, args)).rejects.toThrow(message);
    expect(b.call).not.toHaveBeenCalled();
  });
});
