import { modeOf } from "../connections/store.js";
import { LdapError, type LdapBackend } from "../ldap/backend.js";
import type { AdCallRecord, Connection } from "../types.js";
import type { BindingHandler } from "./sandbox.js";

export interface BindingDeps {
  backend: LdapBackend;
  connection: Connection;
  maxCalls?: number;
}

export const DEFAULT_MAX_CALLS = 200;
export const DEFAULT_ATTRIBUTES = ["name", "objectClass", "sAMAccountName"];
const WRITE_OPS: ReadonlySet<string> = new Set([
  "add", "modify", "delete", "move",
  "gpo.create", "gpo.delete", "gpo.link", "gpo.unlink", "gpo.set", "gpo.remove",
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
        try {
          const found = (await send("search", dn, { base: dn, scope: "base", attributes, max: 1 })) as { entries: unknown[] };
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
        return send("search", typeof opts.base === "string" ? opts.base : "(domain head)", {
          ...(opts.base !== undefined ? { base: stringArg(opts.base, "base") } : {}),
          ...(opts.filter !== undefined ? { filter: stringArg(opts.filter, "filter") } : {}),
          scope,
          attributes,
          ...(opts.max !== undefined ? { max: numberArg(opts.max, "max") } : {}),
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
        return send("modify", dn, { dn, changes });
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
      case "gpo.list":
        return send(op, "", {});
      case "gpo.get":
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
