import type { Catalogue } from "../catalogue/catalogue.js";

/**
 * Turns the helper's ACEs (SIDs, access masks, ACE flags, GUIDs) into what a person reads, and back.
 * The helper does the binary work in .NET, which only runs on Windows; this half runs and is tested
 * everywhere. Names come from the catalogue, which holds every attribute, class and right's GUID.
 */

/** One ACE as the helper reads it from a DACL. */
export interface RawAce {
  type: "allow" | "deny";
  sid: string;
  name: string | null;
  mask: number;
  flags: number;
  objectType: string | null;
  inheritedObjectType: string | null;
}

export type Inheritance = "None" | "All" | "Descendents" | "SelfAndChildren" | "Children";

export interface Ace {
  principal: { sid: string; name: string | null };
  type: "allow" | "deny";
  rights: string[];
  objectType?: string;
  inheritedObjectType?: string;
  inheritance: Inheritance | string;
  inherited: boolean;
}

/** One ACE as the helper takes it for acl.add and acl.remove, in .NET's own enum values. */
export interface EncodedAce {
  principal: string;
  type: "allow" | "deny";
  mask: number;
  inheritanceFlags: number;
  propagationFlags: number;
  objectType?: string;
  inheritedObjectType?: string;
}

/** ActiveDirectoryRights. The Generic* names are composites, used when a mask holds all of one. */
const COMPOSITES: Array<[string, number]> = [
  ["GenericAll", 0xf01ff],
  ["GenericRead", 0x20094],
  ["GenericWrite", 0x20028],
  ["GenericExecute", 0x20004],
];
const BITS: Array<[string, number]> = [
  ["CreateChild", 0x1],
  ["DeleteChild", 0x2],
  ["ListChildren", 0x4],
  ["Self", 0x8],
  ["ReadProperty", 0x10],
  ["WriteProperty", 0x20],
  ["DeleteTree", 0x40],
  ["ListObject", 0x80],
  ["ExtendedRight", 0x100],
  ["Delete", 0x10000],
  ["ReadControl", 0x20000],
  ["WriteDacl", 0x40000],
  ["WriteOwner", 0x80000],
  ["Synchronize", 0x100000],
  ["AccessSystemSecurity", 0x1000000],
];
const RIGHTS = new Map([...COMPOSITES, ...BITS]);

export function rightsOf(mask: number): string[] {
  const exact = COMPOSITES.find(([, m]) => m === mask);
  if (exact) return [exact[0]];
  const out: string[] = [];
  let rest = mask >>> 0;
  if ((rest & 0xf01ff) === 0xf01ff) {
    out.push("GenericAll");
    rest &= ~0xf01ff;
  }
  for (const [name, bit] of BITS) {
    if (rest & bit) {
      out.push(name);
      rest &= ~bit;
    }
  }
  if (rest) out.push(`0x${(rest >>> 0).toString(16)}`);
  return out;
}

export function maskOf(rights: unknown): number {
  if (!Array.isArray(rights) || rights.length === 0) throw new Error("rights must be an array of at least one right, e.g. [\"ReadProperty\"]");
  let mask = 0;
  for (const r of rights) {
    // A hex right is a bit with no name, as rightsOf returns it, so an ACE read back can be removed.
    const bit = typeof r !== "string" ? undefined : /^0x[0-9a-f]+$/i.test(r) ? Number.parseInt(r, 16) : RIGHTS.get(r);
    if (bit === undefined) throw new Error(`Unknown right "${String(r)}". Rights: ${[...RIGHTS.keys()].join(", ")}`);
    mask |= bit;
  }
  return mask >>> 0;
}

// ACE flags: ContainerInherit 0x2, NoPropagateInherit 0x4, InheritOnly 0x8, Inherited 0x10.
// In .NET's enums: InheritanceFlags.ContainerInherit 1; PropagationFlags NoPropagateInherit 1, InheritOnly 2.
const INHERITANCE: Array<[Inheritance, number, number, number]> = [
  // name, ACE flags (CI|NP|IO), InheritanceFlags, PropagationFlags
  ["None", 0x0, 0, 0],
  ["All", 0x2, 1, 0],
  ["Descendents", 0xa, 1, 2],
  ["SelfAndChildren", 0x6, 1, 1],
  ["Children", 0xe, 1, 3],
];

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Names {
  byGuid: Map<string, string>;
  objectByName: Map<string, string[]>;
  classByName: Map<string, string>;
}

const namesCache = new WeakMap<Catalogue, Names>();

function namesOf(catalogue: Catalogue): Names {
  let names = namesCache.get(catalogue);
  if (names) return names;
  const byGuid = new Map<string, string>();
  const objectByName = new Map<string, string[]>();
  const classByName = new Map<string, string>();
  const add = (name: string, guid: string | undefined) => {
    if (!guid) return;
    const g = guid.toLowerCase();
    if (!byGuid.has(g)) byGuid.set(g, name);
    const key = name.toLowerCase();
    const list = objectByName.get(key) ?? [];
    if (!list.includes(g)) list.push(g);
    objectByName.set(key, list);
  };
  for (const [name, a] of Object.entries(catalogue.attributes)) add(name, a.guid);
  for (const [name, c] of Object.entries(catalogue.classes)) {
    add(name, c.guid);
    if (c.guid) classByName.set(name.toLowerCase(), c.guid.toLowerCase());
  }
  for (const [name, r] of Object.entries(catalogue.extendedRights)) {
    add(name, r.guid);
    if (r.displayName && r.displayName.toLowerCase() !== name.toLowerCase()) {
      const key = r.displayName.toLowerCase();
      const list = objectByName.get(key) ?? [];
      if (!list.includes(r.guid.toLowerCase())) list.push(r.guid.toLowerCase());
      objectByName.set(key, list);
    }
  }
  names = { byGuid, objectByName, classByName };
  namesCache.set(catalogue, names);
  return names;
}

export function describeAce(raw: RawAce, catalogue: Catalogue): Ace {
  const names = namesOf(catalogue);
  const nameOf = (guid: string) => names.byGuid.get(guid.toLowerCase()) ?? guid.toLowerCase();
  const shape = raw.flags & 0xe;
  const inheritance = INHERITANCE.find(([, f]) => f === shape)?.[0] ?? `flags 0x${shape.toString(16)}`;
  return {
    principal: { sid: raw.sid, name: raw.name },
    type: raw.type,
    rights: rightsOf(raw.mask),
    ...(raw.objectType ? { objectType: nameOf(raw.objectType) } : {}),
    ...(raw.inheritedObjectType ? { inheritedObjectType: nameOf(raw.inheritedObjectType) } : {}),
    inheritance,
    inherited: (raw.flags & 0x10) !== 0,
  };
}

export function encodeAce(ace: unknown, catalogue: Catalogue): EncodedAce {
  if (typeof ace !== "object" || ace === null || Array.isArray(ace)) throw new Error("ace must be an object");
  const a = ace as Record<string, unknown>;
  // An ACE from getAcl names its principal as { sid, name }; take the SID, so it can be passed back as it is.
  const principal = typeof a.principal === "object" && a.principal !== null ? (a.principal as { sid?: unknown }).sid : a.principal;
  if (typeof principal !== "string" || principal.length === 0) throw new Error('principal must be a name like "CONTOSO\\\\Helpdesk" or a SID like "S-1-1-0"');
  if (a.type !== "allow" && a.type !== "deny") throw new Error('type must be "allow" or "deny"');
  const inheritance = a.inheritance ?? "None";
  const row = INHERITANCE.find(([n]) => n === inheritance);
  if (!row) throw new Error(`inheritance must be ${INHERITANCE.map(([n]) => `"${n}"`).join(", ")}`);
  const names = namesOf(catalogue);
  const out: EncodedAce = { principal, type: a.type, mask: maskOf(a.rights), inheritanceFlags: row[2], propagationFlags: row[3] };
  if (a.objectType !== undefined) {
    const v = guidOrName(a.objectType, "objectType");
    if (GUID_RE.test(v)) out.objectType = v.toLowerCase();
    else {
      const found = names.objectByName.get(v.toLowerCase()) ?? [];
      if (found.length === 0) throw new Error(`No attribute, class or extended right named "${v}". Find the name with search, or pass its GUID.`);
      if (found.length > 1) throw new Error(`"${v}" names more than one attribute, class or extended right. Pass its GUID.`);
      out.objectType = found[0];
    }
  }
  if (a.inheritedObjectType !== undefined) {
    const v = guidOrName(a.inheritedObjectType, "inheritedObjectType");
    if (GUID_RE.test(v)) out.inheritedObjectType = v.toLowerCase();
    else {
      const g = names.classByName.get(v.toLowerCase());
      if (!g) throw new Error(`No class named "${v}". inheritedObjectType is a class, e.g. "user".`);
      out.inheritedObjectType = g;
    }
  }
  return out;
}

/** Whether encoding this ACE needs names looked up, so a plain ACE does not wait for the catalogue. */
export function needsCatalogue(ace: unknown): boolean {
  if (typeof ace !== "object" || ace === null) return false;
  const a = ace as Record<string, unknown>;
  return [a.objectType, a.inheritedObjectType].some((v) => typeof v === "string" && !GUID_RE.test(v));
}

/** Used when the catalogue is not needed, or could not be read: every GUID then stays a GUID. */
export const NO_NAMES = { attributes: {}, classes: {}, extendedRights: {} } as unknown as Catalogue;

function guidOrName(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`${field} must be a name or a GUID`);
  return v;
}
