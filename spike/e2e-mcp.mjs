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
