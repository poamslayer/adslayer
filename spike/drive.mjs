// Drives helper/adslayer-helper.ps1 the way the Node server will, and checks its answers against
// the lab domain from poamslayer/azure-ad-lab. Issue #4.
//
//   node spike/drive.mjs <powershell exe> <helper path> <role: da | delegated>
//
// Prints one PASS/FAIL line per check and exits non-zero if any failed.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [, , psExe, helperPath, role] = process.argv;
const DOMAIN = "lab.adslayer.test";
const BASE = "DC=lab,DC=adslayer,DC=test";
const LAB = `OU=Lab,${BASE}`;

const child = spawn(psExe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(d));
const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    p(msg);
  } else {
    pending.get("orphan")?.(msg);
  }
});

function call(op, args) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, op, args }) + "\n");
  });
}
function raw(line) {
  return new Promise((resolve) => {
    pending.set("orphan", (m) => {
      pending.delete("orphan");
      resolve(m);
    });
    child.stdin.write(line + "\n");
  });
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push([name, "PASS", detail ?? ""]);
  } catch (e) {
    results.push([name, "FAIL", e.message]);
  }
}
function must(cond, message) {
  if (!cond) throw new Error(message);
}
function ok(answer) {
  must(answer.ok, `${answer.error?.code}: ${answer.error?.message}`);
  return answer.value;
}

const t0 = Date.now();
const hello = ok(await call("hello"));
const expectUser = role === "da" ? "lab\\lab.da" : "lab\\lab.delegated";

await check("hello names the logged-on user", async () => {
  must(hello.user.toLowerCase() === expectUser, `user was ${hello.user}`);
  return `${hello.user} on PowerShell ${hello.psVersion} (${hello.psEdition})`;
});

await check("whoami over a sealed Kerberos bind, on the PDC emulator", async () => {
  const v = ok(await call("whoami", { domain: DOMAIN }));
  must(v.user.toLowerCase() === `u:${expectUser}`, `whoami said ${v.user}`);
  must(v.pdc.toLowerCase().startsWith("dc01."), `pdc was ${v.pdc}`);
  return `${v.user} via ${v.pdc}`;
});

await check("search: users under OU=Lab, with GUID and SID as strings", async () => {
  const v = ok(await call("search", { domain: DOMAIN, base: LAB, filter: "(&(objectCategory=person)(objectClass=user)(sAMAccountName=user*))", attributes: ["sAMAccountName", "objectGUID", "objectSid"] }));
  must(v.entries.length === 50, `got ${v.entries.length} users`);
  const a = v.entries[0].attributes;
  must(/^[0-9a-f-]{36}$/.test(a.objectGUID[0]), `objectGUID was ${JSON.stringify(a.objectGUID)}`);
  must(/^S-1-5-21-/.test(a.objectSid[0]), `objectSid was ${JSON.stringify(a.objectSid)}`);
  return `${v.entries.length} users, e.g. ${a.sAMAccountName[0]} ${a.objectSid[0]}`;
});

await check("search pages past 1,000 and stops at max", async () => {
  const v = ok(await call("search", { domain: DOMAIN, base: `OU=Bulk,${LAB}`, filter: "(objectClass=user)", attributes: ["cn"], max: 1200 }));
  must(v.entries.length === 1200 && v.more === true, `got ${v.entries.length}, more=${v.more}`);
  return "1,200 entries, more: true";
});

await check("range retrieval: GG-Bulk member returns all 1,600, ten times", async () => {
  const bad = [];
  for (let i = 0; i < 10; i += 1) {
    const v = ok(await call("search", { domain: DOMAIN, base: `CN=GG-Bulk,OU=Groups,${LAB}`, scope: "base", attributes: ["member"] }));
    const attrs = v.entries[0]?.attributes ?? {};
    const n = attrs.member?.length;
    if (n !== 1600) bad.push(`try ${i + 1}: got ${n}`);
  }
  must(bad.length === 0, bad.join("; "));
  return "1600 members every time";
});

const user01 = `CN=Lab User 01,OU=Sales,${LAB}`;
await check("modify inside OU=Lab is allowed", async () => {
  ok(await call("modify", { domain: DOMAIN, dn: user01, changes: [{ op: "replace", attribute: "description", values: [`drive.mjs ${new Date().toISOString()}`] }] }));
  ok(await call("modify", { domain: DOMAIN, dn: user01, changes: [{ op: "delete", attribute: "description" }] }));
  return "set and cleared description on user01";
});

await check(`modify outside OU=Lab is ${role === "da" ? "allowed" : "refused by AD"}`, async () => {
  const found = ok(await call("search", { domain: DOMAIN, base: `CN=Users,${BASE}`, scope: "one", filter: "(sAMAccountName=labadmin)", attributes: ["description"] }));
  const dn = found.entries[0].dn;
  const before = found.entries[0].attributes.description;
  const answer = await call("modify", { domain: DOMAIN, dn, changes: [{ op: "replace", attribute: "description", values: ["drive.mjs probe"] }] });
  if (role === "da") {
    ok(answer);
    const restore = before ? { op: "replace", attribute: "description", values: before } : { op: "delete", attribute: "description" };
    ok(await call("modify", { domain: DOMAIN, dn, changes: [restore] }));
    return "allowed and restored";
  }
  must(!answer.ok && answer.error.code === "InsufficientAccessRights", `expected InsufficientAccessRights, got ${JSON.stringify(answer)}`);
  return `${answer.error.code}, and the helper kept running`;
});

await check("add, move, rename and delete an object in OU=Lab", async () => {
  const cn = `drive-${role}-${Date.now()}`;
  const dn = `CN=${cn},OU=IT,${LAB}`;
  ok(await call("add", { domain: DOMAIN, dn, attributes: { objectClass: ["top", "contact"], description: "made by drive.mjs" } }));
  const moved = ok(await call("move", { domain: DOMAIN, dn, newParent: `OU=Sales,${LAB}` }));
  const renamed = ok(await call("move", { domain: DOMAIN, dn: moved.dn, newName: `CN=${cn}-renamed` }));
  const got = ok(await call("search", { domain: DOMAIN, base: renamed.dn, scope: "base", attributes: ["description"] }));
  must(got.entries[0].attributes.description[0] === "made by drive.mjs", "description did not survive the move");
  ok(await call("delete", { domain: DOMAIN, dn: renamed.dn }));
  const gone = await call("search", { domain: DOMAIN, base: renamed.dn, scope: "base" });
  must(!gone.ok && gone.error.code === "NoSuchObject", `after delete: ${JSON.stringify(gone)}`);
  return `contact ${cn}: added, moved, renamed, deleted`;
});

await check("errors come back in the protocol, not as a crash", async () => {
  const bad = await raw("this is not json");
  must(!bad.ok && bad.error.code === "BadRequest", JSON.stringify(bad));
  const unknown = await call("frobnicate", {});
  must(!unknown.ok && unknown.error.code === "BadRequest", JSON.stringify(unknown));
  const badDn = await call("search", { domain: DOMAIN, base: "not a dn", scope: "base" });
  must(!badDn.ok, "a malformed DN should fail");
  return `${bad.error.code}, ${unknown.error.code}, ${badDn.error.code}`;
});

await check("100 requests in a row on one connection", async () => {
  const s = Date.now();
  const answers = await Promise.all(Array.from({ length: 100 }, () => call("whoami", { domain: DOMAIN })));
  must(answers.every((a) => a.ok), `${answers.filter((a) => !a.ok).length} failed`);
  return `${Date.now() - s} ms total`;
});

child.stdin.end();
await new Promise((r) => child.on("exit", r));

const failed = results.filter((r) => r[1] !== "PASS").length;
for (const [name, status, detail] of results) console.log(`${status.padEnd(4)} ${name.padEnd(62)} ${detail}`);
console.log(`${failed === 0 ? "DRIVE_PASSED" : "DRIVE_FAILED"} (${results.length - failed}/${results.length}, ${Date.now() - t0} ms)`);
process.exit(failed === 0 ? 0 : 1);
