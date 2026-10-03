import { describe, expect, it } from "vitest";
import { shapeSecuritySettings, type SecurityTemplate } from "../../../src/core/sandbox/gpttmpl.js";

const template = (sections: SecurityTemplate["sections"], names: Record<string, string> = {}): SecurityTemplate => ({ sections, names });

describe("shapeSecuritySettings", () => {
  it("is empty for a GPO with no security template", () => {
    expect(shapeSecuritySettings(template({}))).toEqual({ systemAccess: {}, eventAudit: {}, privilegeRights: {}, groupMembership: [], registryValues: {}, other: {} });
  });

  it("reads System Access as numbers, and names without their quotes", () => {
    const s = shapeSecuritySettings(template({
      "System Access": [["MinimumPasswordLength", "7"], ["LockoutBadCount", "0"], ["MaximumPasswordAge", "-1"], ["NewAdministratorName", '"Administrator"']],
    }));
    expect(s.systemAccess).toEqual({ MinimumPasswordLength: 7, LockoutBadCount: 0, MaximumPasswordAge: -1, NewAdministratorName: "Administrator" });
  });

  it("reads Event Audit as numbers", () => {
    expect(shapeSecuritySettings(template({ "Event Audit": [["AuditLogonEvents", "3"]] })).eventAudit).toEqual({ AuditLogonEvents: 3 });
  });

  it("splits user rights into principals, naming the SIDs it can and keeping bare names", () => {
    const s = shapeSecuritySettings(template(
      { "Privilege Rights": [["SeInteractiveLogonRight", "*S-1-5-32-544,*S-1-5-32-555"], ["SeServiceLogonRight", "LAB\\svc-web"], ["SeDenyNetworkLogonRight", ""]] },
      { "S-1-5-32-544": "BUILTIN\\Administrators" },
    ));
    expect(s.privilegeRights).toEqual({
      SeInteractiveLogonRight: [{ sid: "S-1-5-32-544", name: "BUILTIN\\Administrators" }, { sid: "S-1-5-32-555", name: null }],
      SeServiceLogonRight: [{ sid: null, name: "LAB\\svc-web" }],
      SeDenyNetworkLogonRight: [],
    });
  });

  it("joins a group's Members and Memberof lines into one entry", () => {
    const s = shapeSecuritySettings(template(
      { "Group Membership": [["*S-1-5-32-544__Memberof", ""], ["*S-1-5-32-544__Members", "*S-1-5-21-1-2-3-512,LAB\\ops"], ["*S-1-5-21-1-2-3-1111__Memberof", "*S-1-5-32-555"]] },
      { "S-1-5-32-544": "BUILTIN\\Administrators" },
    ));
    expect(s.groupMembership).toEqual([
      { group: { sid: "S-1-5-32-544", name: "BUILTIN\\Administrators" }, memberOf: [], members: [{ sid: "S-1-5-21-1-2-3-512", name: null }, { sid: null, name: "LAB\\ops" }] },
      { group: { sid: "S-1-5-21-1-2-3-1111", name: null }, memberOf: [{ sid: "S-1-5-32-555", name: null }] },
    ]);
  });

  it("reads Registry Values as type and value, with DWORDs as numbers", () => {
    const s = shapeSecuritySettings(template({
      "Registry Values": [
        ["MACHINE\\System\\CurrentControlSet\\Services\\LanManServer\\Parameters\\RequireSecuritySignature", "4,1"],
        ["MACHINE\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\LegalNoticeCaption", '1,"Notice, read this"'],
        ["MACHINE\\System\\CurrentControlSet\\Control\\SecurePipeServers\\Winreg\\AllowedPaths\\Machine", "7,System\\A,System\\B"],
      ],
    }));
    expect(s.registryValues).toEqual({
      "MACHINE\\System\\CurrentControlSet\\Services\\LanManServer\\Parameters\\RequireSecuritySignature": { type: 4, value: 1 },
      "MACHINE\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\LegalNoticeCaption": { type: 1, value: "Notice, read this" },
      "MACHINE\\System\\CurrentControlSet\\Control\\SecurePipeServers\\Winreg\\AllowedPaths\\Machine": { type: 7, value: "System\\A,System\\B" },
    });
  });

  it("passes any other section through as it is", () => {
    expect(shapeSecuritySettings(template({ "Service General Setting": [['"Spooler"', '4,""']] })).other).toEqual({ "Service General Setting": { '"Spooler"': '4,""' } });
  });
});
