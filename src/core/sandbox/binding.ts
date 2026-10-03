import type { CatalogueCache } from "../catalogue/catalogue.js";
import { modeOf } from "../connections/store.js";
import { LdapError, type LdapBackend } from "../ldap/backend.js";
import type { AdCallRecord, Connection } from "../types.js";
import { NO_NAMES, describeAce, encodeAce, needsCatalogue, type RawAce } from "./acl.js";
import { principal, registryValue, scalar, shapeSecuritySettings, type SecurityTemplate } from "./gpttmpl.js";
import type { BindingHandler } from "./sandbox.js";

export interface BindingDeps {
  backend: LdapBackend;
  connection: Connection;
  maxCalls?: number;
  /** Names the GUIDs in an ACL. Without it, getAcl answers with GUIDs and addAce takes only GUIDs. */
  catalogues?: Pick<CatalogueCache, "get">;
}

export const DEFAULT_MAX_CALLS = 200;
export const DEFAULT_ATTRIBUTES = ["name", "objectClass", "sAMAccountName"];
const WRITE_OPS: ReadonlySet<string> = new Set([
  "add", "modify", "delete", "move", "addAce", "removeAce",
  "gpo.create", "gpo.delete", "gpo.link", "gpo.unlink", "gpo.set", "gpo.remove",
  "gpo.grant", "gpo.revoke", "gpo.setSecurity",
]);

export function makeBinding(deps: BindingDeps): { handle: BindingHandler; calls: () => AdCallRecord[] } {
  const { backend, connection } = deps;
  const maxCalls = deps.maxCalls ?? DEFAULT_MAX_CALLS;
  const records: AdCallRecord[] = [];
  let started = 0;

  async function send(op: string, target: string, args: Record<string, unknown>): Promise<unknown> {
    if (started >= maxCalls) throw new Error(`Call limit of ${maxCalls} reached for this run`);
    started += 1;
    const t0 = Date.now();
    try {
      const value = await backend.call(connection.domain, op, args);
      records.push({ op, target, ok: true, ms: Date.now() - t0 });
      return value;
    } catch (err) {
      const code = err instanceof LdapError ? err.code : undefined;
      records.push({ op, target, ok: false, ...(code ? { code } : {}), ms: Date.now() - t0 });
      // The script sees the message and nothing else, so the code goes in it.
      throw new Error(code ? `${code}: ${(err as Error).message}` : (err as Error).message);
    }
  }

  // A catalogue that cannot be read leaves GUIDs as GUIDs rather than failing the ACL call.
  async function names() {
    if (!deps.catalogues) return NO_NAMES;
    try {
      return await deps.catalogues.get(connection.domain);
    } catch {
      return NO_NAMES;
    }
  }

  const handle: BindingHandler = async (op, args) => {
    // ADR-0004: the mode is the only limit the server sets on a write, and it is checked here,
    // before anything reaches the helper.
    if (WRITE_OPS.has(op) && modeOf(connection) === "read") {
      throw new Error(`Connection "${connection.alias}" was added in read mode, so it cannot ${op}. ${writableHint()}`);
    }
    switch (op) {
      case "get": {
        const dn = stringArg(args[0], "dn");
        const attributes = attributesArg(args[1]) ?? DEFAULT_ATTRIBUTES;
        const opts = args[2] === undefined ? {} : objectArg(args[2], "get options");
        const controls = controlsArg(opts.controls);
        try {
          const found = (await send("search", dn, { base: dn, scope: "base", attributes, max: 1, ...controls })) as { entries: unknown[] };
          return found.entries[0] ?? null;
        } catch (err) {
          if ((err as Error).message.startsWith("NoSuchObject:")) return null;
          throw err;
        }
      }
      case "search": {
        const opts = objectArg(args[0] ?? {}, "search options");
        const attributes = attributesArg(opts.attributes) ?? DEFAULT_ATTRIBUTES;
        const scope = opts.scope ?? "sub";
        if (!["base", "one", "sub"].includes(scope as string)) throw new Error('scope must be "base", "one" or "sub"');
        const controls = controlsArg(opts.controls);
        return send("search", typeof opts.base === "string" ? opts.base : "(domain head)", {
          ...(opts.base !== undefined ? { base: stringArg(opts.base, "base") } : {}),
          ...(opts.filter !== undefined ? { filter: stringArg(opts.filter, "filter") } : {}),
          scope,
          attributes,
          ...(opts.max !== undefined ? { max: numberArg(opts.max, "max") } : {}),
          ...controls,
        });
      }
      case "whoami":
        return send("whoami", "", {});
      case "add": {
        const dn = stringArg(args[0], "dn");
        return send("add", dn, { dn, attributes: objectArg(args[1], "attributes") });
      }
      case "modify": {
        const dn = stringArg(args[0], "dn");
        const changes = args[1];
        if (!Array.isArray(changes) || changes.length === 0) throw new Error("modify needs a non-empty array of { op, attribute, values? }");
        const opts = args[2] === undefined ? {} : objectArg(args[2], "modify options");
        return send("modify", dn, { dn, changes, ...controlsArg(opts.controls) });
      }
      case "delete": {
        const dn = stringArg(args[0], "dn");
        const opts = args[1] === undefined ? {} : objectArg(args[1], "delete options");
        return send("delete", dn, { dn, ...(opts.tree ? { tree: true } : {}) });
      }
      case "move": {
        const dn = stringArg(args[0], "dn");
        const to = objectArg(args[1], "move target");
        if (to.newParent === undefined && to.newName === undefined) throw new Error("move needs newParent, newName, or both");
        return send("move", dn, {
          dn,
          ...(to.newParent !== undefined ? { newParent: stringArg(to.newParent, "newParent") } : {}),
          ...(to.newName !== undefined ? { newName: stringArg(to.newName, "newName") } : {}),
        });
      }
      case "getAcl": {
        const dn = stringArg(args[0], "dn");
        const acl = (await send("acl.get", dn, { dn })) as { owner: unknown; protected: boolean; aces: RawAce[] };
        const catalogue = await names();
        return { dn, owner: acl.owner, protected: acl.protected, aces: acl.aces.map((a) => describeAce(a, catalogue)) };
      }
      case "addAce":
      case "removeAce": {
        const dn = stringArg(args[0], "dn");
        const ace = objectArg(args[1], "ace");
        if (op === "removeAce" && ace.inherited === true) {
          throw new Error("This ACE is inherited from a parent object. Remove it on the parent, or turn off inheritance there.");
        }
        // Names to look up need the catalogue itself: a failure to read it is the error worth seeing.
        const catalogue = needsCatalogue(ace) && deps.catalogues ? await deps.catalogues.get(connection.domain) : NO_NAMES;
        const encoded = encodeAce(ace, catalogue);
        return send(op === "addAce" ? "acl.add" : "acl.remove", dn, { dn, ace: encoded });
      }
      case "gpo.list":
        return send(op, "", {});
      case "gpo.get": {
        const g = stringArg(args[0], "gpo");
        const { securityTemplate, ...found } = (await send(op, g, { gpo: g })) as Record<string, unknown> & { securityTemplate?: SecurityTemplate };
        return { ...found, securitySettings: shapeSecuritySettings(securityTemplate ?? { sections: {}, names: {} }) };
      }
      case "gpo.delete": {
        const g = stringArg(args[0], "gpo");
        return send(op, g, { gpo: g });
      }
      case "gpo.create": {
        const name = stringArg(args[0], "name");
        const opts = args[1] === undefined ? {} : objectArg(args[1], "create options");
        return send(op, name, { name, ...(opts.comment !== undefined ? { comment: stringArg(opts.comment, "comment") } : {}) });
      }
      case "gpo.link": {
        const g = stringArg(args[0], "gpo");
        const target = stringArg(args[1], "target");
        const opts = args[2] === undefined ? {} : objectArg(args[2], "link options");
        return send(op, g, {
          gpo: g,
          target,
          ...(opts.enabled !== undefined ? { enabled: Boolean(opts.enabled) } : {}),
          ...(opts.enforced !== undefined ? { enforced: Boolean(opts.enforced) } : {}),
          ...(opts.order !== undefined ? { order: numberArg(opts.order, "order") } : {}),
        });
      }
      case "gpo.unlink": {
        const g = stringArg(args[0], "gpo");
        return send(op, g, { gpo: g, target: stringArg(args[1], "target") });
      }
      case "gpo.set": {
        const g = stringArg(args[0], "gpo");
        const setting = objectArg(args[1], "setting");
        const type = stringArg(setting.type, "type");
        if (!GPO_TYPES.has(type)) throw new Error("type must be String, ExpandString, DWord, QWord or MultiString");
        if (setting.value === undefined) throw new Error("set needs a value");
        return send(op, g, { gpo: g, key: registryKeyArg(setting.key), valueName: stringArg(setting.valueName, "valueName"), type, value: setting.value });
      }
      case "gpo.remove": {
        const g = stringArg(args[0], "gpo");
        return send(op, g, { gpo: g, key: registryKeyArg(args[1]), ...(args[2] !== undefined ? { valueName: stringArg(args[2], "valueName") } : {}) });
      }
      case "gpo.grant":
      case "gpo.revoke": {
        const g = stringArg(args[0], "gpo");
        const right = stringArg(args[1], "right");
        if (!/^Se\w+(Right|Privilege)$/.test(right)) throw new Error(`right must be a user right such as "SeServiceLogonRight", not "${right}"`);
        if (typeof args[2] !== "string" || args[2].length === 0) throw new Error('principal must be a name like "CONTOSO\\svc-web" or a SID');
        const r = (await send(op, g, { gpo: g, right, principal: args[2] })) as {
          id: string; right: string; sid: string; changed: boolean; defined: boolean | "new"; before: string[]; after: string[]; names: Record<string, string>;
        };
        return {
          id: r.id, right: r.right, principal: principal(`*${r.sid}`, r.names), changed: r.changed, defined: r.defined,
          before: r.before.map((e) => principal(e, r.names)), after: r.after.map((e) => principal(e, r.names)),
        };
      }
      case "gpo.setSecurity": {
        const g = stringArg(args[0], "gpo");
        const section = stringArg(args[1], "section");
        const key = stringArg(args[2], "key");
        const value = encodeSecurityValue(section, key, args[3]);
        const r = (await send(op, g, { gpo: g, section, key, value })) as { id: string; section: string; key: string; changed: boolean; before: string | null; after: string };
        const read = section === "Registry Values" ? registryValue : scalar;
        return { id: r.id, section: r.section, key: r.key, changed: r.changed, before: r.before === null ? null : read(r.before), after: read(r.after) };
      }
      case "gpo.backup": {
        const g = stringArg(args[0], "gpo");
        return send(op, g, { gpo: g, path: stringArg(args[1], "path") });
      }
      default:
        throw new Error(`Unknown operation "${op}"`);
    }
  };

  return { handle, calls: () => records.slice() };
}

/** How a read connection is made writable. ADR-0005. */
export function writableHint(): string {
  return "Add the domain again with connection_add and mode: write.";
}

/**
 * The LDAP controls a script may send, by name. A list, not raw OIDs, because some controls change
 * how a call behaves in ways the helper does not handle, e.g. the notification control never returns.
 * showDeleted (1.2.840.113556.1.4.417) shows objects in the Recycle Bin and allows restoring them.
 */
const CONTROLS: ReadonlySet<string> = new Set(["showDeleted"]);

/** Spread into a helper request: nothing when no control is asked for. */
function controlsArg(v: unknown): { controls?: Record<string, true> } {
  if (v === undefined) return {};
  const controls = objectArg(v, "controls");
  for (const [name, value] of Object.entries(controls)) {
    if (!CONTROLS.has(name)) throw new Error(`Unknown control "${name}". Known controls: ${[...CONTROLS].join(", ")}`);
    if (value !== true) throw new Error(`${name} must be true`);
  }
  return Object.keys(controls).length ? { controls: controls as Record<string, true> } : {};
}

/** [System Access] keys a GPO can set. A list, so a misspelled key is an error and not a setting nothing reads. */
const SYSTEM_ACCESS_KEYS: ReadonlySet<string> = new Set([
  "MinimumPasswordAge", "MaximumPasswordAge", "MinimumPasswordLength", "PasswordComplexity", "PasswordHistorySize",
  "LockoutBadCount", "ResetLockoutCount", "LockoutDuration", "RequireLogonToChangePassword", "ForceLogoffWhenHourExpire",
  "ClearTextPassword", "LSAAnonymousNameLookup", "EnableAdminAccount", "EnableGuestAccount", "NewAdministratorName", "NewGuestName",
]);
const NAME_KEYS: ReadonlySet<string> = new Set(["NewAdministratorName", "NewGuestName"]);

/** A setSecurity value as GptTmpl.inf writes it: 14, "Admin", 4,1, 1,"text" or 7,a,b. */
function encodeSecurityValue(section: string, key: string, value: unknown): string {
  const noQuote = (v: string) => {
    if (v.includes('"')) throw new Error("a value cannot contain a double quote");
    return v;
  };
  if (section === "System Access") {
    if (!SYSTEM_ACCESS_KEYS.has(key)) throw new Error(`Unknown System Access key "${key}". Keys: ${[...SYSTEM_ACCESS_KEYS].join(", ")}`);
    if (NAME_KEYS.has(key)) return `"${noQuote(stringArg(value, key))}"`;
    if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be a whole number`);
    return String(value);
  }
  if (section === "Registry Values") {
    if (!/^MACHINE\\/i.test(key)) throw new Error("key must start with MACHINE\\, e.g. MACHINE\\System\\CurrentControlSet\\Control\\Lsa\\LimitBlankPasswordUse");
    const v = objectArg(value, "value");
    switch (v.type) {
      case 4:
        if (typeof v.value !== "number" || !Number.isInteger(v.value)) throw new Error("a type 4 (DWORD) value must be a whole number");
        return `4,${v.value}`;
      case 1:
      case 2:
        return `${v.type},"${noQuote(stringArg(v.value, "value"))}"`;
      case 7: {
        if (!Array.isArray(v.value) || !v.value.every((x) => typeof x === "string")) throw new Error("a type 7 (multi-string) value must be an array of strings");
        if (v.value.some((x: string) => x.includes(","))) throw new Error("a type 7 value's strings cannot contain a comma, because the template separates them with commas");
        return `7,${(v.value as string[]).map(noQuote).join(",")}`;
      }
      default:
        throw new Error("type must be 1, 2, 4 or 7 (string, expandable string, DWORD, multi-string)");
    }
  }
  throw new Error('section must be "System Access" or "Registry Values"');
}

const GPO_TYPES: ReadonlySet<string> = new Set(["String", "ExpandString", "DWord", "QWord", "MultiString"]);

/** Set-GPRegistryValue takes HKLM\\ or HKCU\\ keys. Policy settings live under those two only. */
function registryKeyArg(v: unknown): string {
  const key = stringArg(v, "key");
  if (!/^(HKLM|HKCU)\\/i.test(key)) throw new Error("key must start with HKLM\\ (computer settings) or HKCU\\ (user settings)");
  return key;
}

function stringArg(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`${name} must be a non-empty string`);
  return v;
}

function numberArg(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive whole number`);
  return v;
}

function objectArg(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${name} must be an object`);
  return v as Record<string, unknown>;
}

function attributesArg(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((a) => typeof a === "string" && a.length > 0)) throw new Error("attributes must be an array of attribute names");
  return v as string[];
}
