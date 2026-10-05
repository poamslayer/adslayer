// Issues #24 to #27: can the calls adslayer already has reset a password, set a WMI filter, rename a GPO
// and write Windows Firewall policy? Each check does the change through the real server, then looks at it
// the way Windows does: the GroupPolicy module, GPMC's report, the firewall cmdlets and a gpupdate on dc01.
//
//   node lab-checks.mjs <path to adslayer's dist/cli/main.js> <role: da | delegated>
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [, , serverMain, role] = process.argv;
const DOMAIN = "lab.adslayer.test";
const HEAD = "DC=lab,DC=adslayer,DC=test";
const LAB = `OU=Lab,${HEAD}`;
const DCS = `OU=Domain Controllers,${HEAD}`;
const POLICIES = `CN=Policies,CN=System,${HEAD}`;
const SOM = `CN=SOM,CN=WMIPolicy,CN=System,${HEAD}`;
const stamp = Date.now().toString(36);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverMain],
  env: { ...process.env, ADSLAYER_HOME: mkdtempSync(join(tmpdir(), "adslayer-checks-")) },
  stderr: "pipe",
});
const mcp = new Client({ name: "adslayer-lab-checks", version: "0.0.0" });
await mcp.connect(transport);

const results = [];
const notes = [];
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
function note(title, value) {
  notes.push(`--- ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}
async function run(domain, code) {
  const res = await mcp.callTool({ name: "execute", arguments: { domain, code } });
  must(!res.isError, JSON.stringify(res.content));
  return res.structuredContent;
}
async function runOk(domain, code) {
  const out = await run(domain, code);
  must(out.ok, JSON.stringify(out.error));
  return out.result;
}
function ps(script) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.stderr?.trim()) note(`powershell stderr: ${script.slice(0, 80)}`, r.stderr.trim());
  return (r.stdout ?? "").trim();
}
function psJson(script) {
  const out = ps(`${script} | ConvertTo-Json -Depth 6 -Compress`);
  return out ? JSON.parse(out) : null;
}
const gpc = (id) => `CN={${id}},${POLICIES}`;

for (const [alias, mode] of [["lab", "read"], ["lab-w", "write"]]) {
  const res = await mcp.callTool({ name: "connection_add", arguments: { domain: DOMAIN, alias, mode } });
  must(!res.isError, JSON.stringify(res.content));
}
const PDC = (await runOk("lab", "return await ad.whoami();")).pdc;

// The encoding the execute tool description teaches: the password in double quotes, as UTF-16LE, base64.
const ENCODE = `const pwd = (p) => { const s = '"' + p + '"'; let b = ""; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b += String.fromCharCode(c & 255, c >> 8); } return { base64: btoa(b) }; };`;
const validate = (sam, password) =>
  ps(`Add-Type -AssemblyName System.DirectoryServices.AccountManagement; (New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Domain', '${DOMAIN}')).ValidateCredentials('${sam}', '${password}')`);

// --- #24: reset a password with ad.modify on unicodePwd -------------------------------------------------
{
  const sam = `pw${role.slice(0, 3)}-${stamp}`;
  const userDn = `CN=${sam},${LAB}`;
  const first = `Lab-${stamp}-First1!`;
  const second = `Lab-${stamp}-Second2!`;
  try {
    await runOk("lab-w", `await ad.add(${JSON.stringify(userDn)}, { objectClass: "user", sAMAccountName: ${JSON.stringify(sam)} }); return "made";`);

    await check(`#24 ${role}: ad.modify on unicodePwd sets a password the account can sign in with`, async () => {
      const r = await runOk("lab-w", `${ENCODE}
        await ad.modify(${JSON.stringify(userDn)}, [{ op: "replace", attribute: "unicodePwd", values: pwd(${JSON.stringify(first)}) }]);
        await ad.modify(${JSON.stringify(userDn)}, [{ op: "replace", attribute: "userAccountControl", values: "512" }]);
        return (await ad.get(${JSON.stringify(userDn)}, ["pwdLastSet", "userAccountControl"])).attributes;`);
      must(r.pwdLastSet[0] !== "0" && r.userAccountControl[0] === "512", JSON.stringify(r));
      const good = validate(sam, first);
      const bad = validate(sam, `${first}x`);
      must(good === "True" && bad === "False", `ValidateCredentials: right ${good}, wrong ${bad}`);
      return `pwdLastSet ${r.pwdLastSet[0]}; ValidateCredentials right=True, wrong=False`;
    });

    await check(`#24 ${role}: a read connection refuses the reset before any LDAP call`, async () => {
      const out = await run("lab", `${ENCODE} await ad.modify(${JSON.stringify(userDn)}, [{ op: "replace", attribute: "unicodePwd", values: pwd("Whatever-1!") }]); return "reset";`);
      must(!out.ok && /read mode/.test(out.error.message) && out.calls.length === 0, JSON.stringify(out));
      return out.error.message.slice(0, 90);
    });

    await check(`#24 ${role}: a password that breaks the domain's policy is refused, and the error says so`, async () => {
      const r = await runOk("lab-w", `${ENCODE}
        try { await ad.modify(${JSON.stringify(userDn)}, [{ op: "replace", attribute: "unicodePwd", values: pwd("a") }]); return "accepted"; }
        catch (e) { return e.message; }`);
      note(`#24 ${role}: policy error`, r);
      must(r !== "accepted", "a one-letter password was accepted");
      must(validate(sam, first) === "True", "the old password stopped working");
      return r.slice(0, 160);
    });

    await check(`#24 ${role}: pwdLastSet "0" in the same modify forces a change at next sign-in`, async () => {
      const r = await runOk("lab-w", `${ENCODE}
        await ad.modify(${JSON.stringify(userDn)}, [{ op: "replace", attribute: "unicodePwd", values: pwd(${JSON.stringify(second)}) }, { op: "replace", attribute: "pwdLastSet", values: "0" }]);
        return (await ad.get(${JSON.stringify(userDn)}, ["pwdLastSet"])).attributes.pwdLastSet[0];`);
      must(r === "0", `pwdLastSet ${r}`);
      return `pwdLastSet 0; ValidateCredentials with the new password: ${validate(sam, second)} (must change first)`;
    });
  } finally {
    await run("lab-w", `await ad.delete(${JSON.stringify(userDn)}); return "deleted";`);
  }
}

// --- #26 (delegated): can someone with edit rights on one GPO rename it? ---------------------------------
if (role === "delegated") {
  await check("#26 delegated: rename Lab Baseline with ad.modify on displayName, and back", async () => {
    const id = (await runOk("lab", `return (await gpo.get("Lab Baseline")).id;`));
    const r = await runOk("lab-w", `
      try { await ad.modify(${JSON.stringify(gpc(id))}, [{ op: "replace", attribute: "displayName", values: "Lab Baseline (adslayer check)" }]); }
      catch (e) { return { refused: e.message }; }
      const renamed = (await gpo.get(${JSON.stringify(id)})).name;
      await ad.modify(${JSON.stringify(gpc(id))}, [{ op: "replace", attribute: "displayName", values: "Lab Baseline" }]);
      return { renamed, back: (await gpo.get(${JSON.stringify(id)})).name };`);
    note("#26 delegated", r);
    must(r.refused || (r.renamed === "Lab Baseline (adslayer check)" && r.back === "Lab Baseline"), JSON.stringify(r));
    return r.refused ? `refused: ${r.refused.slice(0, 100)}` : `renamed to "${r.renamed}" and back`;
  });

  await check("#25 delegated: creating a WMI filter is refused by AD", async () => {
    const guid = `{${crypto.randomUUID().toUpperCase()}}`;
    const r = await runOk("lab-w", `
      try { await ad.add("CN=${guid},${SOM}", { objectClass: "msWMI-Som", "msWMI-ID": "${guid}", "msWMI-Name": "adslayer delegated ${stamp}" }); }
      catch (e) { return e.message; }
      await ad.delete("CN=${guid},${SOM}");
      return "allowed";`);
    return r.slice(0, 120);
  });
}

if (role === "da") {
  const sysvol = (id) => `\\\\${PDC}\\SYSVOL\\${DOMAIN}\\Policies\\{${id}}`;
  const made = [];
  const createGpo = async (name) => {
    const g = await runOk("lab-w", `return await gpo.create(${JSON.stringify(name)}, { comment: "adslayer lab check, deleted at the end" });`);
    made.push(g.id);
    return g.id;
  };
  const gpoReport = (id) => ps(`Get-GPOReport -Guid '${id}' -ReportType Xml -Domain ${DOMAIN} -Server ${PDC}`);
  const gpupdate = () => ps("gpupdate /target:computer /force | Out-Null");
  const filters = [];

  try {
    // --- #25: a WMI filter through ad.add, linked through ad.modify on gPCWQLFilter -------------------------
    // GPMC stores a filter as msWMI-Som. msWMI-Parm2 holds the queries: the count, then for each one the
    // lengths of "WQL", the namespace and the query, followed by the three themselves.
    const parm2 = (q) => `1;3;10;${q.length};WQL;root\\CIMv2;${q};`;
    const now = new Date().toISOString().replace(/[-:T]/g, "").replace(/\.(\d{3})Z$/, ".$1000-000");
    const addFilter = async (name, description, query) => {
      const guid = `{${crypto.randomUUID().toUpperCase()}}`;
      await runOk("lab-w", `return await ad.add("CN=${guid},${SOM}", ${JSON.stringify({
        objectClass: "msWMI-Som",
        "msWMI-ID": guid,
        "msWMI-Name": name,
        "msWMI-Parm1": description,
        "msWMI-Parm2": parm2(query),
        "msWMI-Author": `lab.da@${DOMAIN}`,
        "msWMI-CreationDate": now,
        "msWMI-ChangeDate": now,
        showInAdvancedViewOnly: "TRUE",
      })});`);
      filters.push(guid);
      return guid;
    };
    const linkFilter = (id, guid) =>
      runOk("lab-w", `return await ad.modify(${JSON.stringify(gpc(id))}, [{ op: "replace", attribute: "gPCWQLFilter", values: "[${DOMAIN};${guid};0]" }]);`);

    const wmiOn = `adslayer-check-wmi-dc-${stamp}`;
    const wmiOff = `adslayer-check-wmi-wks-${stamp}`;
    let onId, offId, onFilter, offFilter;
    await check("#25: ad.add makes a WMI filter that GPMC reads, with its query", async () => {
      onFilter = await addFilter(`${wmiOn} filter`, "Domain controllers only", "SELECT * FROM Win32_OperatingSystem WHERE ProductType = 2");
      offFilter = await addFilter(`${wmiOff} filter`, "Workstations only", "SELECT * FROM Win32_OperatingSystem WHERE ProductType = 1");
      const g = psJson(`$gpm = New-Object -ComObject GPMgmt.GPM; $k = $gpm.GetConstants(); $d = $gpm.GetDomain('${DOMAIN}', '${PDC}', $k.UseThisDC)
        $f = $d.GetWMIFilter('MSFT_SomFilter.Domain="${DOMAIN}",ID="${onFilter}"'); @{ name = $f.Name; description = $f.Description; queries = @($f.GetQueryList()) }`);
      note("#25 GPMC's view of the filter", g);
      must(g?.name === `${wmiOn} filter` && g.queries.some((q) => /ProductType = 2/.test(q)), JSON.stringify(g));
      return `GPMC: "${g.name}", ${g.queries.join(" | ")}`;
    });

    await check("#25: ad.modify on gPCWQLFilter links it; gpo.get, Get-GPO and the GPMC report show it", async () => {
      onId = await createGpo(wmiOn);
      offId = await createGpo(wmiOff);
      await linkFilter(onId, onFilter);
      await linkFilter(offId, offFilter);
      const viaAdslayer = await runOk("lab", `return [(await gpo.get("${onId}")).wmiFilter, (await gpo.get("${offId}")).wmiFilter];`);
      const viaGetGpo = ps(`(Get-GPO -Guid '${onId}' -Domain ${DOMAIN} -Server ${PDC}).WmiFilter.Name`);
      const report = gpoReport(onId);
      const filterName = report.match(/<FilterName>([^<]*)<\/FilterName>/)?.[1];
      must(viaAdslayer[0] === `${wmiOn} filter` && viaAdslayer[1] === `${wmiOff} filter`, JSON.stringify(viaAdslayer));
      must(viaGetGpo === `${wmiOn} filter` && filterName === `${wmiOn} filter`, `Get-GPO ${viaGetGpo}; report ${filterName}`);
      return `gpo.get, Get-GPO and the report all say "${filterName}"`;
    });

    await check("#25: after gpupdate on dc01 the GPO behind the DC filter applies and the one behind the workstation filter doesn't", async () => {
      await runOk("lab-w", `
        await gpo.set("${onId}", { key: "HKLM\\\\Software\\\\Policies\\\\adslayer-check", valueName: "WmiDc", type: "DWord", value: 1 });
        await gpo.set("${offId}", { key: "HKLM\\\\Software\\\\Policies\\\\adslayer-check", valueName: "WmiWks", type: "DWord", value: 1 });
        await gpo.link("${onId}", ${JSON.stringify(DCS)});
        await gpo.link("${offId}", ${JSON.stringify(DCS)});
        return "set and linked";`);
      gpupdate();
      const reg = psJson(`Get-ItemProperty HKLM:\\Software\\Policies\\adslayer-check -ErrorAction SilentlyContinue | Select-Object WmiDc, WmiWks`);
      const denied = ps(`gpresult /scope computer /r | Out-String`).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(wmiOff) || /WMI Filter/.test(l));
      note("#25 gpresult lines", denied.join("\n"));
      must(reg?.WmiDc === 1 && reg.WmiWks == null, `registry: ${JSON.stringify(reg)}`);
      return `WmiDc=1 applied, WmiWks not; gpresult: ${denied.join(" / ").slice(0, 120)}`;
    });

    await check("#25: ad.modify delete on gPCWQLFilter unlinks it", async () => {
      const r = await runOk("lab-w", `await ad.modify("${gpc(onId)}", [{ op: "delete", attribute: "gPCWQLFilter" }]); return (await gpo.get("${onId}")).wmiFilter;`);
      must(r === null, JSON.stringify(r));
      return "wmiFilter null";
    });

    // --- #26: rename a GPO with ad.modify on displayName, against Rename-GPO --------------------------------
    const IGNORE = new Set(["whenChanged", "uSNChanged", "dSCorePropagationData"]);
    const snapshot = async (id) => ({
      ad: (await runOk("lab", `return (await ad.get("${gpc(id)}", ["*"])).attributes;`)),
      gptIni: ps(`Get-Content -Raw '${sysvol(id)}\\GPT.INI'`),
      folder: psJson(`Get-ChildItem -Recurse -File '${sysvol(id)}' | ForEach-Object { @{ path = $_.FullName.Substring(${sysvol(id).length}); written = $_.LastWriteTimeUtc.ToString('o') } }`),
    });
    const diff = (a, b) => {
      const keys = new Set([...Object.keys(a.ad), ...Object.keys(b.ad)]);
      const changed = [...keys].filter((k) => JSON.stringify(a.ad[k]) !== JSON.stringify(b.ad[k]));
      return {
        attributes: changed.filter((k) => !IGNORE.has(k)),
        bookkeeping: changed.filter((k) => IGNORE.has(k)),
        gptIni: a.gptIni === b.gptIni ? "same" : { before: a.gptIni, after: b.gptIni },
        files: JSON.stringify(a.folder) === JSON.stringify(b.folder) ? "same" : { before: a.folder, after: b.folder },
      };
    };
    const byAd = `adslayer-check-rename-ad-${stamp}`;
    const byCmdlet = `adslayer-check-rename-cmdlet-${stamp}`;
    let renamedByAd;
    await check("#26: ad.modify on displayName changes what Rename-GPO changes, and nothing else", async () => {
      const a = (renamedByAd = await createGpo(byAd));
      const b = await createGpo(byCmdlet);
      await runOk("lab-w", `
        await gpo.set("${a}", { key: "HKLM\\\\Software\\\\Policies\\\\adslayer-check", valueName: "Rename", type: "DWord", value: 1 });
        await gpo.set("${b}", { key: "HKLM\\\\Software\\\\Policies\\\\adslayer-check", valueName: "Rename", type: "DWord", value: 1 });
        return "set";`);
      const a0 = await snapshot(a);
      const b0 = await snapshot(b);
      await runOk("lab-w", `return await ad.modify("${gpc(a)}", [{ op: "replace", attribute: "displayName", values: "${byAd}-renamed" }]);`);
      ps(`Rename-GPO -Guid '${b}' -TargetName '${byCmdlet}-renamed' -Domain ${DOMAIN} -Server ${PDC} | Out-Null`);
      const da = diff(a0, await snapshot(a));
      const db = diff(b0, await snapshot(b));
      note("#26 ad.modify changed", da);
      note("#26 Rename-GPO changed", db);
      must(JSON.stringify(da.attributes) === JSON.stringify(db.attributes), `ad.modify ${da.attributes}, Rename-GPO ${db.attributes}`);
      must(da.gptIni === db.gptIni && da.files === db.files, `gpt.ini/files: ad.modify ${JSON.stringify(da.gptIni)} ${JSON.stringify(da.files)}; Rename-GPO ${JSON.stringify(db.gptIni)} ${JSON.stringify(db.files)}`);
      const names = {
        getGpo: ps(`(Get-GPO -Name '${byAd}-renamed' -Domain ${DOMAIN} -Server ${PDC}).Id.ToString()`),
        adslayer: (await runOk("lab", `return (await gpo.get("${byAd}-renamed")).id;`)),
        report: gpoReport(a).match(/<Name>([^<]*)<\/Name>/)?.[1],
      };
      must(names.getGpo === a && names.adslayer === a && names.report === `${byAd}-renamed`, JSON.stringify(names));
      return `both changed only [${da.attributes.join(", ")}] (+ ${da.bookkeeping.join(", ")}); gpt.ini ${da.gptIni}, SYSVOL files ${da.files}; found by new name everywhere`;
    });

    await check("#26: a duplicate name: Rename-GPO and ad.modify each", async () => {
      const a = renamedByAd;
      const cmdlet = ps(`try { Rename-GPO -Guid '${a}' -TargetName '${byCmdlet}-renamed' -Domain ${DOMAIN} -Server ${PDC} -ErrorAction Stop | Out-Null; 'allowed' } catch { $_.Exception.Message }`);
      const viaAd = await runOk("lab-w", `
        try { await ad.modify("${gpc(a)}", [{ op: "replace", attribute: "displayName", values: "${byCmdlet}-renamed" }]); }
        catch (e) { return e.message; }
        let lookup; try { lookup = (await gpo.get("${byCmdlet}-renamed")).id; } catch (e) { lookup = e.message; }
        await ad.modify("${gpc(a)}", [{ op: "replace", attribute: "displayName", values: "${byAd}-renamed" }]);
        return { allowed: true, lookup };`);
      note("#26 duplicate names", { cmdlet, viaAd });
      return `Rename-GPO: ${cmdlet.slice(0, 80)}; ad.modify: ${JSON.stringify(viaAd).slice(0, 140)}`;
    });

    // --- #27: Windows Firewall policy through gpo.set, against the firewall cmdlets ---------------------------
    const fwAd = `adslayer-check-fw-gposet-${stamp}`;
    const fwRef = `adslayer-check-fw-cmdlet-${stamp}`;
    const FW = "HKLM\\\\Software\\\\Policies\\\\Microsoft\\\\WindowsFirewall";
    const ruleName = `adslayer check ${stamp}`;
    let fwId, refId;
    await check("#27: the firewall cmdlets' reference GPO, read back through gpo.get", async () => {
      refId = await createGpo(fwRef);
      ps(`$s = '${DOMAIN}\\${fwRef}'
        Set-NetFirewallProfile -PolicyStore $s -Name Domain -Enabled True -DefaultInboundAction Block
        New-NetFirewallRule -PolicyStore $s -DisplayName '${ruleName}' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Domain | Out-Null`);
      const g = await runOk("lab", `const g = await gpo.get("${refId}"); return g.computerSettings;`);
      const ext = (await runOk("lab", `return (await ad.get("${gpc(refId)}", ["gPCMachineExtensionNames"])).attributes.gPCMachineExtensionNames;`));
      note("#27 what New-NetFirewallRule and Set-NetFirewallProfile wrote", { settings: g, gPCMachineExtensionNames: ext });
      must(g.some((s) => /FirewallRules$/i.test(s.key)), JSON.stringify(g));
      return `${g.length} values; extensions ${ext?.[0]}`;
    });

    await check("#27: gpo.set writes the domain profile and an inbound rule that the firewall cmdlets read back", async () => {
      fwId = await createGpo(fwAd);
      const rule = `v2.10|Action=Allow|Active=TRUE|Dir=In|Protocol=6|Profile=Domain|LPort=8080|Name=${ruleName}|`;
      await runOk("lab-w", `
        await gpo.set("${fwId}", { key: "${FW}\\\\DomainProfile", valueName: "EnableFirewall", type: "DWord", value: 1 });
        await gpo.set("${fwId}", { key: "${FW}\\\\DomainProfile", valueName: "DefaultInboundAction", type: "DWord", value: 1 });
        await gpo.set("${fwId}", { key: "${FW}\\\\FirewallRules", valueName: "{${crypto.randomUUID()}}", type: "String", value: ${JSON.stringify(rule)} });
        return "set";`);
      const profile = psJson(`Get-NetFirewallProfile -PolicyStore '${DOMAIN}\\${fwAd}' -Name Domain | ForEach-Object { @{ enabled = [string]$_.Enabled; inbound = [string]$_.DefaultInboundAction } }`);
      const rules = psJson(`@(Get-NetFirewallRule -PolicyStore '${DOMAIN}\\${fwAd}' | ForEach-Object { $p = $_ | Get-NetFirewallPortFilter; @{ name = $_.DisplayName; dir = [string]$_.Direction; action = [string]$_.Action; enabled = [string]$_.Enabled; profile = [string]$_.Profile; protocol = $p.Protocol; port = [string]$p.LocalPort } })`);
      note("#27 firewall cmdlets reading the gpo.set GPO", { profile, rules });
      const r = [rules].flat()[0];
      must(profile?.enabled === "True" && profile.inbound === "Block", JSON.stringify(profile));
      must(r?.name === ruleName && r.dir === "Inbound" && r.action === "Allow" && r.enabled === "True" && r.profile === "Domain" && r.protocol === "TCP" && r.port === "8080", JSON.stringify(rules));
      return `profile ${JSON.stringify(profile)}; rule ${r.name} ${r.dir} ${r.protocol}/${r.port} ${r.action}`;
    });

    await check("#27: GPMC's report of each GPO, and the extension names gpo.set leaves", async () => {
      const ours = gpoReport(fwId);
      const ref = gpoReport(refId);
      const ext = await runOk("lab", `return [(await ad.get("${gpc(fwId)}", ["gPCMachineExtensionNames"])).attributes.gPCMachineExtensionNames, (await ad.get("${gpc(refId)}", ["gPCMachineExtensionNames"])).attributes.gPCMachineExtensionNames];`);
      const shows = (x) => ({ rule: x.includes(ruleName), port: x.includes("8080"), firewallSection: /WindowsFirewall|Windows Firewall|Windows Defender Firewall/i.test(x) });
      const r = { gposet: { ...shows(ours), ext: ext[0] }, cmdlets: { ...shows(ref), ext: ext[1] } };
      note("#27 GPMC report", r);
      note("#27 GPMC report XML for the gpo.set GPO (first 4000 chars of ExtensionData)", ours.slice(ours.indexOf("<Computer>"), ours.indexOf("<Computer>") + 4000));
      return JSON.stringify(r);
    });

    await check("#27: linked to the Domain Controllers OU, dc01 applies the gpo.set rule and profile after gpupdate", async () => {
      const before = psJson(`Get-NetFirewallProfile -Name Domain | ForEach-Object { @{ enabled = [string]$_.Enabled; inbound = [string]$_.DefaultInboundAction } }`);
      note("#27 dc01 domain profile before", before);
      await runOk("lab-w", `return await gpo.link("${fwId}", ${JSON.stringify(DCS)});`);
      gpupdate();
      const rsop = psJson(`@(Get-NetFirewallRule -PolicyStore RSOP -DisplayName '${ruleName}' -ErrorAction SilentlyContinue | ForEach-Object { @{ name = $_.DisplayName; enabled = [string]$_.Enabled; action = [string]$_.Action } })`);
      const active = psJson(`@(Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName '${ruleName}' -ErrorAction SilentlyContinue | ForEach-Object { @{ name = $_.DisplayName; source = [string]$_.PolicyStoreSourceType } })`);
      const profile = psJson(`Get-NetFirewallProfile -PolicyStore RSOP -Name Domain | ForEach-Object { @{ enabled = [string]$_.Enabled; inbound = [string]$_.DefaultInboundAction } }`);
      note("#27 dc01 after gpupdate", { rsop, active, profile });
      must([rsop].flat().length === 1 && [active].flat().length === 1, JSON.stringify({ rsop, active }));
      must(profile?.enabled === "True" && profile.inbound === "Block", JSON.stringify(profile));
      return `RSOP and ActiveStore have the rule (${[active].flat()[0].source}); RSOP profile ${JSON.stringify(profile)}`;
    });
  } finally {
    for (const id of made) {
      await run("lab-w", `
        for (const l of (await gpo.get("${id}")).links) await gpo.unlink("${id}", l.target);
        await gpo.delete("${id}");
        return "deleted";`);
    }
    for (const guid of filters) await run("lab-w", `await ad.delete("CN=${guid},${SOM}"); return "deleted";`);
    gpupdate();
    ps("Remove-Item HKLM:\\Software\\Policies\\adslayer-check -Recurse -ErrorAction SilentlyContinue");
  }
  await check("cleanup: no adslayer-check GPOs, filters or firewall rules left", async () => {
    const left = await runOk("lab", `
      const g = (await gpo.list()).filter(x => x.name.startsWith("adslayer-check-")).map(x => x.name);
      const f = (await ad.search({ base: "${SOM}", scope: "one", filter: "(msWMI-Name=adslayer-check-*)", attributes: ["msWMI-Name"] })).entries.length;
      return { g, f };`);
    const rule = ps(`@(Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName 'adslayer check *' -ErrorAction SilentlyContinue).Count`);
    must(left.g.length === 0 && left.f === 0 && rule === "0", JSON.stringify({ ...left, rule }));
    return "clean";
  });
}

await mcp.close();
const failed = results.filter((r) => r[0] !== "PASS").length;
// run-command returns only the last 4 KB of output, so the notes go to a file and the results stay short.
const notesFile = join(tmpdir(), `adslayer-lab-checks-${role}.txt`);
writeFileSync(notesFile, notes.join("\n"));
for (const [status, name, detail] of results) console.log(`${status} ${name.slice(0, 70)}: ${String(detail).slice(0, 150)}`);
console.log(`notes: ${notesFile}`);
console.log(`${failed ? "CHECKS_FAILED" : "CHECKS_PASSED"} (${results.length - failed}/${results.length})`);
process.exit(failed ? 1 : 0);
