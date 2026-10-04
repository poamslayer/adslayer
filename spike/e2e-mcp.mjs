// End to end on the lab DC: a real MCP client drives the installed adslayer server over stdio,
// which runs scripts in workerd and reaches AD through the PowerShell helper. Issue #6.
//
//   node e2e-mcp.mjs <path to adslayer's dist/cli/main.js> <role: da | delegated>
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [, , serverMain, role] = process.argv;
const LAB = "OU=Lab,DC=lab,DC=adslayer,DC=test";
const USER01 = `CN=Lab User 01,OU=Sales,${LAB}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverMain],
  env: { ...process.env, ADSLAYER_HOME: mkdtempSync(join(tmpdir(), "adslayer-e2e-")) },
  stderr: "pipe",
});
const mcp = new Client({ name: "adslayer-e2e", version: "0.0.0" });
await mcp.connect(transport);

const results = [];
async function check(name, fn) {
  try {
    results.push(["PASS", name, (await fn()) ?? ""]);
  } catch (e) {
    results.push(["FAIL", name, e.message]);
  }
}
function must(cond, message) {
  if (!cond) throw new Error(message);
}
async function run(domain, code) {
  const res = await mcp.callTool({ name: "execute", arguments: { domain, code } });
  must(!res.isError, JSON.stringify(res.content));
  return res.structuredContent;
}

await check("the server lists its six tools", async () => {
  const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
  must(names.join() === "connection_add,connection_remove,connections_list,docs,execute,search", names.join());
  return names.join(", ");
});

await check("connection_add: a read and a write connection, no sign-in", async () => {
  for (const [alias, mode] of [["lab", "read"], ["lab-w", "write"]]) {
    const res = await mcp.callTool({ name: "connection_add", arguments: { domain: "lab.adslayer.test", alias, mode } });
    must(!res.isError, JSON.stringify(res.content));
  }
  return "lab (read), lab-w (write)";
});

await check("execute: whoami is the logged-on user, via the PDC emulator", async () => {
  const out = await run("lab", "return await ad.whoami();");
  must(out.ok, JSON.stringify(out.error));
  must(out.result.user.toLowerCase() === `u:lab\\lab.${role}`, out.result.user);
  return `${out.result.user} via ${out.result.pdc}`;
});

await check("execute: GG-Bulk has 1,600 members", async () => {
  const out = await run("lab", `const g = await ad.get("CN=GG-Bulk,OU=Groups,${LAB}", ["member"]); return g.attributes.member.length;`);
  must(out.ok && out.result === 1600, JSON.stringify(out));
  return `${out.result} members, ${out.calls.length} call`;
});

await check("execute: a filter, then a join in the script", async () => {
  const out = await run("lab", `
    const groups = await ad.search({ base: "OU=Groups,${LAB}", filter: "(objectClass=group)", attributes: ["name", "member"] });
    return groups.entries.map(g => ({ name: g.attributes.name[0], members: (g.attributes.member ?? []).length })).sort((a, b) => b.members - a.members);`);
  must(out.ok && out.result[0].name === "GG-Bulk", JSON.stringify(out.result ?? out.error));
  return out.result.map((g) => `${g.name}=${g.members}`).join(" ");
});

await check("execute: a write through the write connection, inside OU=Lab", async () => {
  const stamp = `e2e ${role} ${new Date().toISOString()}`;
  const out = await run("lab-w", `
    await ad.modify("${USER01}", [{ op: "replace", attribute: "description", values: "${stamp}" }]);
    const back = (await ad.get("${USER01}", ["description"])).attributes.description[0];
    await ad.modify("${USER01}", [{ op: "delete", attribute: "description" }]);
    return back;`);
  must(out.ok && out.result === stamp, JSON.stringify(out.result ?? out.error));
  return "set, read back, cleared";
});

await check("execute: the same write through the read connection is refused before any LDAP call", async () => {
  const out = await run("lab", `await ad.modify("${USER01}", [{ op: "replace", attribute: "description", values: "x" }]); return "wrote";`);
  must(!out.ok && /read mode/.test(out.error.message), JSON.stringify(out));
  must(out.calls.length === 0, `calls: ${JSON.stringify(out.calls)}`);
  return out.error.message.slice(0, 70) + "…";
});

await check(`execute: a write outside OU=Lab is ${role === "da" ? "allowed" : "refused by AD"}`, async () => {
  const out = await run("lab-w", `
    const u = (await ad.search({ base: "CN=Users,DC=lab,DC=adslayer,DC=test", scope: "one", filter: "(sAMAccountName=labadmin)", attributes: ["description"] })).entries[0];
    try {
      await ad.modify(u.dn, [{ op: "replace", attribute: "description", values: "e2e" }]);
      const before = u.attributes.description;
      await ad.modify(u.dn, [before ? { op: "replace", attribute: "description", values: before } : { op: "delete", attribute: "description" }]);
      return "allowed";
    } catch (e) { return e.message; }`);
  must(out.ok, JSON.stringify(out.error));
  if (role === "da") must(out.result === "allowed", out.result);
  else must(/^InsufficientAccessRights:/.test(out.result), out.result);
  return out.result.slice(0, 60);
});

// Issue #2: the Recycle Bin. A user made for the test is deleted, found with showDeleted, and restored.
{
  const sam = `e2e-${Date.now().toString(36)}`;
  const userDn = `CN=${sam},${LAB}`;
  const groupDn = `CN=${sam}-g,${LAB}`;
  const findDeleted = `(await ad.search({ base: "CN=Deleted Objects,DC=lab,DC=adslayer,DC=test", filter: "(&(isDeleted=TRUE)(sAMAccountName=${sam}))", attributes: ["lastKnownParent", "msDS-LastKnownRDN"], controls: { showDeleted: true } })).entries[0]`;
  const restore = `await ad.modify(gone.dn, [{ op: "delete", attribute: "isDeleted" }, { op: "replace", attribute: "distinguishedName", values: "CN=" + gone.attributes["msDS-LastKnownRDN"][0] + "," + gone.attributes.lastKnownParent[0] }], { controls: { showDeleted: true } })`;

  const made = await run("lab-w", `
    await ad.add("${userDn}", { objectClass: "user", sAMAccountName: "${sam}" });
    ${role === "da" ? `await ad.add("${groupDn}", { objectClass: "group", sAMAccountName: "${sam}-g" });
    await ad.modify("${groupDn}", [{ op: "add", attribute: "member", values: "${userDn}" }]);` : ""}
    await ad.delete("${userDn}");
    return "made and deleted";`);

  if (role === "da") {
    await check("execute: the read connection finds the deleted user but refuses to restore it", async () => {
      must(made.ok, JSON.stringify(made.error));
      const out = await run("lab", `const gone = ${findDeleted}; if (!gone) return "not found"; try { ${restore}; return "restored"; } catch (e) { return e.message; }`);
      must(out.ok && /read mode/.test(out.result), JSON.stringify(out.result ?? out.error));
      must(out.calls.length === 1 && out.calls[0].op === "search", `calls: ${JSON.stringify(out.calls)}`);
      return "found; restore refused before any LDAP call";
    });

    await check("execute: restore a deleted user from the Recycle Bin, with its group membership", async () => {
      must(made.ok, JSON.stringify(made.error));
      const out = await run("lab-w", `
        const gone = ${findDeleted};
        if (!gone) return { found: false };
        const back = ${restore};
        const u = await ad.get(back.dn, ["memberOf", "isDeleted"]);
        return { found: true, dn: back.dn, memberOf: u?.attributes.memberOf ?? [], isDeleted: u?.attributes.isDeleted ?? null };`);
      must(out.ok, JSON.stringify(out.error));
      must(out.result.found, "the deleted user was not in CN=Deleted Objects");
      must(out.result.dn === userDn && out.result.isDeleted === null, JSON.stringify(out.result));
      must(out.result.memberOf.includes(groupDn), `memberOf: ${JSON.stringify(out.result.memberOf)}`);
      return `restored to ${userDn.split(",")[0]}, still a member of ${groupDn.split(",")[0]}`;
    });
  } else {
    await check("execute: lab.delegated cannot restore from the Recycle Bin", async () => {
      must(made.ok, JSON.stringify(made.error));
      const out = await run("lab-w", `const gone = ${findDeleted}; if (!gone) return "not visible"; try { ${restore}; return "restored"; } catch (e) { return e.message; }`);
      must(out.ok, JSON.stringify(out.error));
      must(out.result !== "restored", "lab.delegated restored the user; the lab grants it Reanimate Tombstones");
      return out.result === "not visible" ? "Deleted Objects not visible to lab.delegated" : out.result.slice(0, 60);
    });
  }

  // Leave nothing behind in OU=Lab. A deleted object stays in the Recycle Bin until it expires.
  await run("lab-w", `for (const dn of ["${userDn}", "${groupDn}"]) { try { await ad.delete(dn); } catch (e) { if (!/^NoSuchObject:/.test(e.message)) throw e; } } return "clean";`);
}

// Issue #1: ACLs. An OU and a group made for the test; both are deleted at the end.
{
  const stamp = Date.now().toString(36);
  const ouDn = `OU=e2e-acl-${stamp},${LAB}`;
  const groupSam = `e2e-${stamp}-h`;
  const groupDn = `CN=${groupSam},${LAB}`;
  const protect = `{ principal: "S-1-1-0", type: "deny", rights: ["Delete", "DeleteTree"] }`;
  // AD allows a delete with Delete on the object or DeleteChild on its parent, so protecting needs both.
  const protectParent = `{ principal: "S-1-1-0", type: "deny", rights: ["DeleteChild"] }`;
  const reset = `{ principal: "LAB\\\\${groupSam}", type: "allow", rights: ["ExtendedRight"], objectType: "User-Force-Change-Password", inheritedObjectType: "user", inheritance: "Descendents" }`;
  const made = await run("lab-w", `
    await ad.add("${ouDn}", { objectClass: "organizationalUnit" });
    await ad.add("${groupDn}", { objectClass: "group", sAMAccountName: "${groupSam}" });
    return "made";`);

  await check("execute: getAcl on OU=Lab shows lab.delegated's full control", async () => {
    const out = await run("lab", `const acl = await ad.getAcl("${LAB}"); return { owner: acl.owner, n: acl.aces.length, mine: acl.aces.filter(a => (a.principal.name ?? "").toLowerCase() === "lab\\\\lab.delegated") };`);
    must(out.ok, JSON.stringify(out.error));
    must(out.result.mine.some((a) => a.type === "allow" && a.rights.includes("GenericAll")), JSON.stringify(out.result.mine));
    return `${out.result.n} ACEs, owner ${out.result.owner.name}; lab.delegated: ${out.result.mine.map((a) => `${a.rights.join("+")} ${a.inheritance}`).join(", ")}`;
  });

  await check("execute: protect a new OU from deletion, see the delete refused, then unprotect and delete it", async () => {
    must(made.ok, JSON.stringify(made.error));
    const out = await run("lab-w", `
      await ad.addAce("${ouDn}", ${protect});
      await ad.addAce("${LAB}", ${protectParent});
      let refused;
      try { await ad.delete("${ouDn}"); refused = "deleted"; } catch (e) { refused = e.message; }
      const un = await ad.removeAce("${ouDn}", ${protect});
      // The lab keeps no deny on OU=Lab once the test is over.
      const unParent = await ad.removeAce("${LAB}", ${protectParent});
      if (refused !== "deleted") await ad.delete("${ouDn}");
      return { refused, removed: un.removed && unParent.removed, gone: (await ad.get("${ouDn}")) === null };`);
    must(out.ok, JSON.stringify(out.error));
    must(/^InsufficientAccessRights:/.test(out.result.refused), `delete while protected: ${out.result.refused}`);
    must(out.result.removed && out.result.gone, JSON.stringify(out.result));
    return "delete refused while protected; deleted after removeAce";
  });

  await check("execute: grant Reset Password on users in an OU to a group, read it back by name, remove it", async () => {
    const out = await run("lab-w", `
      await ad.add("${ouDn}", { objectClass: "organizationalUnit" });
      await ad.addAce("${ouDn}", ${reset});
      const granted = (await ad.getAcl("${ouDn}")).aces.filter(a => a.principal.name?.toLowerCase() === "lab\\\\${groupSam}");
      const un = await ad.removeAce("${ouDn}", granted[0]);
      const left = (await ad.getAcl("${ouDn}")).aces.filter(a => a.principal.name?.toLowerCase() === "lab\\\\${groupSam}");
      return { granted, removed: un.removed, left: left.length };`);
    must(out.ok, JSON.stringify(out.error));
    const g = out.result.granted;
    must(g.length === 1 && g[0].objectType === "User-Force-Change-Password" && g[0].inheritedObjectType === "user" && g[0].inheritance === "Descendents" && g[0].rights.join() === "ExtendedRight", JSON.stringify(g));
    must(out.result.removed && out.result.left === 0, JSON.stringify(out.result));
    return `granted to ${g[0].principal.name}; removed cleanly`;
  });

  await check("execute: the read connection refuses addAce before any LDAP call", async () => {
    const out = await run("lab", `await ad.addAce("${LAB}", ${protect}); return "added";`);
    must(!out.ok && /read mode/.test(out.error.message) && out.calls.length === 0, JSON.stringify(out));
    return "refused, 0 calls";
  });

  await run("lab-w", `for (const dn of ["${ouDn}", "${groupDn}"]) { try { await ad.delete(dn, { tree: true }); } catch (e) { if (!/^NoSuchObject:/.test(e.message)) throw e; } } return "clean";`);
}

async function search(code, refresh) {
  const t0 = Date.now();
  const res = await mcp.callTool({ name: "search", arguments: { domain: "lab", code, ...(refresh ? { refresh } : {}) } });
  must(!res.isError, JSON.stringify(res.content));
  const out = res.structuredContent;
  must(out.ok, JSON.stringify(out.error));
  return { result: out.result, ms: Date.now() - t0 };
}

await check("search: the catalogue is read live, with a Windows Server 2025 forest", async () => {
  const { result, ms } = await search("return { attributes: Object.keys(catalogue.attributes).length, classes: Object.keys(catalogue.classes).length, rights: Object.keys(catalogue.extendedRights).length, forest: catalogue.forestFunctionality, dc: catalogue.dc };");
  must(result.attributes > 1000 && result.classes > 200 && result.forest >= 10, JSON.stringify(result));
  return `${result.attributes} attributes, ${result.classes} classes, ${result.rights} rights, forest level ${result.forest}, ${ms} ms`;
});

await check("search: member, msLAPS-Password, user, controls and rights read correctly", async () => {
  const { result, ms } = await search(`return {
    member: catalogue.attributes.member,
    laps: catalogue.attributes["msLAPS-Password"],
    userMay: catalogue.classes.user.may.includes("telephoneNumber") && catalogue.classes.user.may.includes("memberOf"),
    paged: catalogue.controls.some(c => c.name === "Paged results"),
    reset: catalogue.extendedRights["User-Force-Change-Password"],
  };`);
  must(result.member.syntax === "DN" && result.member.linkID === 2 && !result.member.single, JSON.stringify(result.member));
  must(result.laps?.confidential === true, JSON.stringify(result.laps));
  must(result.userMay && result.paged, JSON.stringify(result));
  must(result.reset.appliesTo.includes("user") && result.reset.kind === "control", JSON.stringify(result.reset));
  return `cached: ${ms} ms`;
});

await check("search: refresh reads the domain again", async () => {
  const { result } = await search("return catalogue.readAt;", true);
  return `readAt ${result}`;
});

await check("search: the policy settings from the ADMX files", async () => {
  const { result } = await search(`return { n: catalogue.policies.length, source: catalogue.policiesSource, error: catalogue.policiesError, lock: catalogue.policies.find(p => p.valueName === "NoLockScreen") };`);
  must(result.n > 1000 && result.lock?.class === "Machine" && result.lock.valueName === "NoLockScreen", JSON.stringify(result).slice(0, 300));
  return `${result.n} policies from ${result.source}; NoLockScreen → ${result.lock.key}`;
});

await check("execute: gpo.get shows Lab Baseline's link and the value it sets", async () => {
  const out = await run("lab", `
    const all = await gpo.list();
    const g = await gpo.get("Lab Baseline");
    return { count: all.length, links: g.links, settings: g.computerSettings };`);
  must(out.ok, JSON.stringify(out.error));
  const { links, settings, count } = out.result;
  must(links.some((l) => l.target === LAB && l.enabled), JSON.stringify(links));
  must(settings.some((s) => s.valueName === "NoLockScreen" && s.value === 1 && s.type === "DWord"), JSON.stringify(settings));
  return `${count} GPOs; Lab Baseline linked to OU=Lab, NoLockScreen = 1`;
});

// Issue #12: a GPO's security settings, from GptTmpl.inf.
await check("execute: gpo.get reads password and lockout policy from the Default Domain Policy", async () => {
  const out = await run("lab", `const s = (await gpo.get("Default Domain Policy")).securitySettings; return { sa: s.systemAccess, rights: Object.keys(s.privilegeRights).length };`);
  must(out.ok, JSON.stringify(out.error));
  const sa = out.result.sa;
  must(typeof sa.MinimumPasswordLength === "number" && typeof sa.LockoutBadCount === "number", JSON.stringify(sa));
  return `MinimumPasswordLength ${sa.MinimumPasswordLength}, LockoutBadCount ${sa.LockoutBadCount}, PasswordComplexity ${sa.PasswordComplexity}`;
});

await check("execute: gpo.get reads user rights by name from the Default Domain Controllers Policy", async () => {
  const out = await run("lab", `return (await gpo.get("Default Domain Controllers Policy")).securitySettings.privilegeRights.SeInteractiveLogonRight;`);
  must(out.ok, JSON.stringify(out.error));
  must(out.result.some((p) => p.sid === "S-1-5-32-555" && p.name === "BUILTIN\\Remote Desktop Users"), JSON.stringify(out.result));
  return out.result.map((p) => p.name ?? p.sid).join(", ");
});

// Issue #16: writing GPO security settings (ADR-0011).
{
  const { spawnSync } = await import("node:child_process");
  const ps = (script) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).stdout.trim();
  // Who holds a right in this DC's local security database, where the security extension writes what it applies.
  const localRight = (right) => ps(String.raw`$f = "$env:TEMP\adslayer-e2e-rights.inf"; secedit /export /areas USER_RIGHTS /cfg $f | Out-Null; $l = Get-Content $f | Where-Object { $_ -match '^${right}\s*=' }; Remove-Item $f; if ($l) { ($l -split '=', 2)[1].Trim() }`);
  const RDU = "S-1-5-32-555";

  if (role === "da") {
    const name = `adslayer-e2e-sec-${Date.now().toString(36)}`;
    const DCS = "OU=Domain Controllers,DC=lab,DC=adslayer,DC=test";
    const holders = localRight("SeTimeZonePrivilege").split(",").map((s) => s.trim()).filter((s) => s && s !== `*${RDU}`);
    let id;
    try {
      await check("execute: gpo.grant defines a user right on a new GPO, and it applies on dc01 after gpupdate", async () => {
        const out = await run("lab-w", `
          const g = await gpo.create(${JSON.stringify(name)}, { comment: "adslayer e2e, deleted at the end" });
          await gpo.link(g.id, ${JSON.stringify(DCS)}, { order: 1 });
          const steps = [];
          for (const sid of ${JSON.stringify(holders.map((h) => h.replace(/^\*/, "")))}) steps.push(await gpo.grant(g.id, "SeTimeZonePrivilege", sid));
          steps.push(await gpo.grant(g.id, "SeTimeZonePrivilege", "${RDU}"));
          const again = await gpo.grant(g.id, "SeTimeZonePrivilege", "${RDU}");
          return { id: g.id, defined: steps.map(s => s.defined), last: steps.at(-1), again: { changed: again.changed }, read: (await gpo.get(g.id)).securitySettings.privilegeRights.SeTimeZonePrivilege };`);
        must(out.ok, JSON.stringify(out.error));
        id = out.result.id;
        must(out.result.defined[0] === "new" && out.result.defined.slice(1).every((d) => d === true), `defined: ${JSON.stringify(out.result.defined)}`);
        must(out.result.last.principal.name === "BUILTIN\\Remote Desktop Users" && out.result.again.changed === false, JSON.stringify(out.result));
        must(out.result.read.length === holders.length + 1, JSON.stringify(out.result.read));
        ps("gpupdate /target:computer /force | Out-Null");
        const local = localRight("SeTimeZonePrivilege");
        must(local.includes(`*${RDU}`), `local database after gpupdate: ${local}`);
        must(ps(`(Get-GPOReport -Guid '${id}' -ReportType Xml) -match 'SeTimeZonePrivilege'`) === "True", "GPMC report does not show the right");
        return `granted ${holders.length + 1} one at a time; applied (local: ${local}); in GPMC report; a second grant changed nothing`;
      });

      await check("execute: gpo.revoke removes one principal and keeps the others", async () => {
        const out = await run("lab-w", `return await gpo.revoke("${id}", "SeTimeZonePrivilege", "${RDU}");`);
        must(out.ok, JSON.stringify(out.error));
        const r = out.result;
        must(r.changed && r.defined === true && !r.after.some((p) => p.sid === RDU) && r.after.length === r.before.length - 1, JSON.stringify(r));
        return `${r.before.length} -> ${r.after.length}: ${r.after.map((p) => p.name ?? p.sid).join(", ")}`;
      });

      await check("execute: gpo.setSecurity adds or replaces one key and leaves every other line alone", async () => {
        const path = ps(`(Get-ADDomain).PDCEmulator`);
        const file = `\\\\${path}\\SYSVOL\\lab.adslayer.test\\Policies\\{${id}}\\Machine\\Microsoft\\Windows NT\\SecEdit\\GptTmpl.inf`;
        const read = () => ps(`[IO.File]::ReadAllText('${file}')`).split(/\r?\n/);
        const diff = (x, y) => ({ added: y.filter((l) => !x.includes(l)), removed: x.filter((l) => !y.includes(l)) });
        // The GPO has no [System Access] yet: the first set adds the section and the key, and nothing else.
        const first = read();
        const out = await run("lab-w", `return await gpo.setSecurity("${id}", "System Access", "MinimumPasswordLength", 14);`);
        must(out.ok, JSON.stringify(out.error));
        const second = read();
        const d1 = diff(first, second);
        must(out.result.changed && out.result.before === null && out.result.after === 14, JSON.stringify(out.result));
        must(d1.added.join("|") === "[System Access]|MinimumPasswordLength = 14" && d1.removed.length === 0, JSON.stringify(d1));
        // Then a change to that key replaces exactly one line.
        const out2 = await run("lab-w", `return await gpo.setSecurity("${id}", "System Access", "MinimumPasswordLength", 12);`);
        must(out2.ok && out2.result.before === 14 && out2.result.after === 12, JSON.stringify(out2.result ?? out2.error));
        const third = read();
        const d2 = diff(second, third);
        must(d2.added.join() === "MinimumPasswordLength = 12" && d2.removed.join() === "MinimumPasswordLength = 14" && third.length === second.length, JSON.stringify(d2));
        return `added the section and key; then replaced 1 line, ${third.length - 1} others unchanged`;
      });

      await check("execute: a GPO whose AD and SYSVOL versions disagree is refused before anything is written", async () => {
        const out = await run("lab-w", `
          const gpc = "CN={${id}},CN=Policies,CN=System,DC=lab,DC=adslayer,DC=test";
          const v = Number((await ad.get(gpc, ["versionNumber"])).attributes.versionNumber[0]);
          await ad.modify(gpc, [{ op: "replace", attribute: "versionNumber", values: String(v + 1) }]);
          let refused;
          try { await gpo.setSecurity("${id}", "System Access", "MinimumPasswordLength", 15); refused = "written"; } catch (e) { refused = e.message; }
          const still = (await gpo.get("${id}")).securitySettings.systemAccess.MinimumPasswordLength;
          return { refused, still };`);
        must(out.ok, JSON.stringify(out.error));
        must(/^GpoVersionMismatch:/.test(out.result.refused) && out.result.still === 12, JSON.stringify(out.result));
        return out.result.refused.slice(0, 80) + "…";
      });
    } finally {
      if (id) await run("lab-w", `await gpo.unlink("${id}", ${JSON.stringify(DCS)}); await gpo.delete("${id}"); return "deleted";`);
      ps("gpupdate /target:computer /force | Out-Null");
      // Tattooing: the right stays as the deleted GPO left it. Put it back as it was.
      const inf = ["[Unicode]", "Unicode=yes", "[Version]", 'signature="$CHICAGO$"', "Revision=1", "[Privilege Rights]", `SeTimeZonePrivilege = ${holders.join(",")}`].join("\r\n");
      ps(String.raw`$c = "$env:TEMP\adslayer-e2e-restore.inf"; $d = "$env:TEMP\adslayer-e2e-restore.sdb"; [IO.File]::WriteAllText($c, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(inf).toString("base64")}')), [Text.Encoding]::Unicode); secedit /configure /db $d /cfg $c /areas USER_RIGHTS /quiet | Out-Null; Remove-Item $c, $d -ErrorAction SilentlyContinue`);
    }
    await check("execute: cleanup leaves SeTimeZonePrivilege on dc01 as it was", async () => {
      const now = localRight("SeTimeZonePrivilege");
      must(now === holders.join(","), `now ${now}, was ${holders.join(",")}`);
      return now;
    });
  } else {
    await check("execute: lab.delegated can grant and revoke on Lab Baseline, which ends as it was", async () => {
      const out = await run("lab-w", `
        const before = (await gpo.get("Lab Baseline")).securitySettings.privilegeRights;
        const g = await gpo.grant("Lab Baseline", "SeTimeZonePrivilege", "${RDU}");
        const r = await gpo.revoke("Lab Baseline", "SeTimeZonePrivilege", "${RDU}");
        const after = (await gpo.get("Lab Baseline")).securitySettings.privilegeRights;
        return { before, after, grant: { changed: g.changed, defined: g.defined }, revoke: { changed: r.changed, defined: r.defined } };`);
      must(out.ok, JSON.stringify(out.error));
      const r = out.result;
      must(r.grant.changed && r.revoke.changed && r.revoke.defined === false, JSON.stringify(r));
      must(JSON.stringify(r.before) === JSON.stringify(r.after), `before ${JSON.stringify(r.before)}, after ${JSON.stringify(r.after)}`);
      return `grant defined ${r.grant.defined}; revoke undefined it; Lab Baseline's user rights as before`;
    });
  }
}

await check("execute: a read connection refuses gpo.create before any call", async () => {
  const out = await run("lab", `await gpo.create("should not exist"); return "made";`);
  must(!out.ok && /read mode/.test(out.error.message) && out.calls.length === 0, JSON.stringify(out));
  return "refused, 0 calls";
});

if (role === "da") {
  await check("execute: create, set, link (disabled), back up, then undo, as a Domain Admin", async () => {
    const name = `adslayer e2e ${Date.now()}`;
    const out = await run("lab-w", `
      const made = await gpo.create(${JSON.stringify(name)}, { comment: "adslayer e2e, deleted at the end" });
      await gpo.set(made.id, { key: "HKLM\\\\Software\\\\Policies\\\\adslayer-e2e", valueName: "Probe", type: "DWord", value: 7 });
      await gpo.link(made.id, ${JSON.stringify(LAB)}, { enabled: false });
      const got = await gpo.get(made.id);
      const backup = await gpo.backup(made.id, "C:\\\\Windows\\\\Temp\\\\adslayer-gpo-backup");
      await gpo.remove(made.id, "HKLM\\\\Software\\\\Policies\\\\adslayer-e2e", "Probe");
      await gpo.unlink(made.id, ${JSON.stringify(LAB)});
      const after = await gpo.get(made.id);
      await gpo.delete(made.id);
      const gone = (await gpo.list()).some(g => g.id === made.id);
      return { version: got.computerVersion, setting: got.computerSettings, link: got.links, backup: !!backup.backupId, afterSettings: after.computerSettings.length, afterLinks: after.links.length, gone: !gone };`);
    must(out.ok, JSON.stringify(out.error));
    const r = out.result;
    must(r.setting.some((s) => s.valueName === "Probe" && s.value === 7), JSON.stringify(r.setting));
    must(r.link.length === 1 && r.link[0].enabled === false, JSON.stringify(r.link));
    must(r.backup && r.afterSettings === 0 && r.afterLinks === 0 && r.gone, JSON.stringify(r));
    return `version ${r.version} after set; link disabled; backed up; removed, unlinked, deleted; ${out.calls.length} calls`;
  });
} else {
  await check("execute: lab.delegated can edit Lab Baseline but cannot create a GPO", async () => {
    const out = await run("lab-w", `
      let create;
      try { await gpo.create("delegated should not create this"); create = "made"; } catch (e) { create = e.message; }
      await gpo.set("Lab Baseline", { key: "HKLM\\\\Software\\\\Policies\\\\adslayer-e2e", valueName: "Delegated", type: "String", value: "yes" });
      const set = (await gpo.get("Lab Baseline")).computerSettings.some(s => s.valueName === "Delegated" && s.value === "yes");
      await gpo.remove("Lab Baseline", "HKLM\\\\Software\\\\Policies\\\\adslayer-e2e", "Delegated");
      const cleared = !(await gpo.get("Lab Baseline")).computerSettings.some(s => s.valueName === "Delegated");
      return { create, set, cleared };`);
    must(out.ok, JSON.stringify(out.error));
    must(/^AccessDenied:/.test(out.result.create), `expected AccessDenied, got ${out.result.create}`);
    must(out.result.set && out.result.cleared, JSON.stringify(out.result));
    return `create refused (${out.result.create.slice(0, 60)}); edit set and cleared`;
  });
}

await mcp.close();
const failed = results.filter((r) => r[0] !== "PASS").length;
for (const [status, name, detail] of results) console.log(`${status} ${name.padEnd(86)} ${detail}`);
console.log(`${failed ? "E2E_FAILED" : "E2E_PASSED"} (${results.length - failed}/${results.length})`);
process.exit(failed ? 1 : 0);
