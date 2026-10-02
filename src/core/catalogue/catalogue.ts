import type { LdapBackend } from "../ldap/backend.js";

/**
 * One domain's catalogue, read live from the domain (ADR-0010). Shaped for a script to filter, so
 * names are keys and the fields are the ones a person asks about, not every schema attribute.
 */
export interface Catalogue {
  domain: string;
  readAt: string;
  dc: string;
  schemaNamingContext: string;
  forestFunctionality: number;
  domainFunctionality: number;
  attributes: Record<string, CatalogueAttribute>;
  classes: Record<string, CatalogueClass>;
  controls: Array<{ oid: string; name?: string }>;
  extendedRights: Record<string, CatalogueRight>;
  /** The settings a GPO can set, from the ADMX files. Empty, with policiesError, when they could not be read. */
  policies: CataloguePolicy[];
  policiesSource?: string;
  policiesError?: string;
}

export interface CataloguePolicy {
  name: string;
  displayName: string;
  /** Machine settings go under HKLM, User settings under HKCU, Both under either. */
  class: "Machine" | "User" | "Both";
  key: string;
  valueName?: string;
  category: string;
  file: string;
  elements: Array<{ type: string; id?: string; valueName?: string; key?: string }>;
}

export interface CatalogueAttribute {
  oid: string;
  guid?: string;
  syntax: string;
  single: boolean;
  confidential?: true;
  indexed?: true;
  systemOnly?: true;
  /** Forward links are even, back links odd. The back link of `member` is `memberOf`. */
  linkID?: number;
  range?: [number | null, number | null];
  /** The property set the attribute belongs to, by its extended right name, e.g. Personal-Information. */
  propertySet?: string;
  description?: string;
}

export interface CatalogueClass {
  oid: string;
  guid?: string;
  kind: "structural" | "abstract" | "auxiliary" | "88";
  parent: string;
  /** Required and optional attributes, including those inherited from parents and auxiliary classes. */
  must: string[];
  may: string[];
  auxiliary: string[];
  possibleSuperiors: string[];
  description?: string;
}

export interface CatalogueRight {
  displayName: string;
  guid: string;
  kind: "control" | "propertySet" | "validatedWrite" | "other";
  /** Class names, where the class is in this schema; otherwise the schemaIDGUID. */
  appliesTo: string[];
}

/** Shown to the model in the search tool description. Keep it short. */
export const CATALOGUE_TYPES = `
declare const catalogue: {
  domain: string; readAt: string; dc: string; schemaNamingContext: string;
  forestFunctionality: number; domainFunctionality: number;   // 10 = Windows Server 2025
  attributes: Record<string, {           // keyed by lDAPDisplayName, e.g. "member"
    oid: string; guid?: string; syntax: string;   // e.g. "DN", "UnicodeString", "LargeInteger", "SID"
    single: boolean; confidential?: true; indexed?: true; systemOnly?: true;
    linkID?: number; range?: [number | null, number | null]; propertySet?: string; description?: string;
  }>;
  classes: Record<string, {              // keyed by lDAPDisplayName, e.g. "user"
    oid: string; guid?: string; kind: "structural" | "abstract" | "auxiliary" | "88"; parent: string;
    must: string[]; may: string[];       // including inherited and auxiliary-class attributes
    auxiliary: string[]; possibleSuperiors: string[]; description?: string;
  }>;
  controls: Array<{ oid: string; name?: string }>;   // what the DC supports
  extendedRights: Record<string, {       // keyed by name, e.g. "User-Force-Change-Password"
    displayName: string; guid: string; kind: "control" | "propertySet" | "validatedWrite" | "other"; appliesTo: string[];
  }>;
  // Policy settings from the ADMX files (the domain's central store, or the local PolicyDefinitions).
  // To set one with gpo.set, prefix key with HKLM\\ for class Machine or HKCU\\ for class User.
  // A policy's own valueName is set to 1 to enable it; elements are its extra values.
  policies: Array<{ name: string; displayName: string; class: "Machine" | "User" | "Both"; key: string; valueName?: string;
    category: string; file: string; elements: Array<{ type: string; id?: string; valueName?: string; key?: string }> }>;
  policiesSource?: string; policiesError?: string;
};
`.trim();

type Values = Array<string | { base64: string }>;
interface Entry {
  dn: string;
  attributes: Record<string, Values>;
}

const ATTRIBUTE_FIELDS = [
  "lDAPDisplayName", "attributeID", "schemaIDGUID", "attributeSyntax", "oMSyntax", "isSingleValued", "searchFlags",
  "systemOnly", "linkID", "rangeLower", "rangeUpper", "attributeSecurityGUID", "adminDescription",
];
const CLASS_FIELDS = [
  "lDAPDisplayName", "governsID", "schemaIDGUID", "objectClassCategory", "subClassOf", "mustContain", "systemMustContain",
  "mayContain", "systemMayContain", "auxiliaryClass", "systemAuxiliaryClass", "possSuperiors", "systemPossSuperiors",
  "adminDescription",
];

/** attributeSyntax, with oMSyntax where one attributeSyntax covers several. From MS-ADTS 3.1.1.2.2.2. */
export function syntaxName(attributeSyntax: string, oMSyntax: string): string {
  const key = `${attributeSyntax}/${oMSyntax}`;
  const exact: Record<string, string> = {
    "2.5.5.5/22": "IA5String",
    "2.5.5.9/10": "Enumeration",
    "2.5.5.10/127": "ReplicaLink",
    "2.5.5.11/23": "UTCTime",
  };
  if (exact[key]) return exact[key];
  const bySyntax: Record<string, string> = {
    "2.5.5.1": "DN",
    "2.5.5.2": "OID",
    "2.5.5.3": "CaseExactString",
    "2.5.5.4": "CaseIgnoreString",
    "2.5.5.5": "PrintableString",
    "2.5.5.6": "NumericString",
    "2.5.5.7": "DNWithBinary",
    "2.5.5.8": "Boolean",
    "2.5.5.9": "Integer",
    "2.5.5.10": "OctetString",
    "2.5.5.11": "GeneralizedTime",
    "2.5.5.12": "UnicodeString",
    "2.5.5.13": "PresentationAddress",
    "2.5.5.14": "DNWithString",
    "2.5.5.15": "NTSecurityDescriptor",
    "2.5.5.16": "LargeInteger",
    "2.5.5.17": "SID",
  };
  return bySyntax[attributeSyntax] ?? attributeSyntax;
}

/** Names for the controls a DC lists most often. From Microsoft Learn's rootDSE and LDAP controls pages. */
const CONTROL_NAMES: Record<string, string> = {
  "1.2.840.113556.1.4.319": "Paged results",
  "1.2.840.113556.1.4.801": "Security descriptor flags (SD_FLAGS)",
  "1.2.840.113556.1.4.473": "Server-side sort",
  "1.2.840.113556.1.4.528": "Notification",
  "1.2.840.113556.1.4.417": "Show deleted",
  "1.2.840.113556.1.4.619": "Lazy commit",
  "1.2.840.113556.1.4.841": "DirSync",
  "1.2.840.113556.1.4.529": "Extended DN",
  "1.2.840.113556.1.4.805": "Tree delete",
  "1.2.840.113556.1.4.521": "Cross-domain move target",
  "1.2.840.113556.1.4.970": "Get stats",
  "1.2.840.113556.1.4.1338": "Verify name",
  "1.2.840.113556.1.4.474": "Sort response",
  "1.2.840.113556.1.4.1339": "Domain scope",
  "1.2.840.113556.1.4.1340": "Search options",
  "1.2.840.113556.1.4.1413": "Permissive modify",
  "2.16.840.1.113730.3.4.9": "Virtual list view (VLV) request",
  "2.16.840.1.113730.3.4.10": "Virtual list view (VLV) response",
  "1.2.840.113556.1.4.1504": "Attribute scoped query (ASQ)",
  "1.2.840.113556.1.4.1852": "Quota control",
  "1.2.840.113556.1.4.802": "Range retrieval without error",
  "1.2.840.113556.1.4.1907": "Shutdown notify",
  "1.2.840.113556.1.4.1948": "Range retrieval no error",
  "1.2.840.113556.1.4.1974": "Force update",
  "1.2.840.113556.1.4.2026": "DN input",
  "1.2.840.113556.1.4.2064": "Show recycled",
  "1.2.840.113556.1.4.2065": "Show deactivated link",
  "1.2.840.113556.1.4.2066": "Policy hints (deprecated)",
  "1.2.840.113556.1.4.2090": "DirSync extended",
  "1.2.840.113556.1.4.2204": "Tree delete ex",
  "1.2.840.113556.1.4.2205": "Updates stats",
  "1.2.840.113556.1.4.2206": "Search hints",
  "1.2.840.113556.1.4.2211": "Expected entry count",
  "1.2.840.113556.1.4.2239": "Policy hints",
  "1.2.840.113556.1.4.2255": "Set owner",
  "1.2.840.113556.1.4.2256": "Bypass quota",
  "1.2.840.113556.1.4.2309": "Link TTL",
  "1.2.840.113556.1.4.2330": "Set correlation id",
  "1.2.840.113556.1.4.2354": "Thread trace override",
};

function first(e: Entry, name: string): string | undefined {
  const v = e.attributes[name]?.[0];
  return typeof v === "string" ? v : undefined;
}
function all(e: Entry, name: string): string[] {
  return (e.attributes[name] ?? []).filter((v): v is string => typeof v === "string");
}
function num(e: Entry, name: string): number | undefined {
  const v = first(e, name);
  return v === undefined ? undefined : Number(v);
}

/** Reads one domain's catalogue through the helper: the rootDSE, the schema, the extended rights. */
export async function readCatalogue(backend: LdapBackend, domain: string, now: () => Date = () => new Date()): Promise<Catalogue> {
  const root = (await backend.call(domain, "rootdse", {})) as Record<string, string[]>;
  const schema = root.schemaNamingContext[0];
  const config = root.configurationNamingContext[0];
  const search = async (base: string, filter: string, attributes: string[]) =>
    ((await backend.call(domain, "search", { base, scope: "one", filter, attributes, max: 20000 })) as { entries: Entry[] }).entries;
  const [attrEntries, classEntries, rightEntries, policyRead] = await Promise.all([
    search(schema, "(objectClass=attributeSchema)", ATTRIBUTE_FIELDS),
    search(schema, "(objectClass=classSchema)", CLASS_FIELDS),
    search(`CN=Extended-Rights,${config}`, "(objectClass=controlAccessRight)", ["cn", "displayName", "rightsGuid", "appliesTo", "validAccesses"]),
    // Policy definitions come from files, not LDAP. A machine without them still gets the schema.
    (backend.call(domain, "policydefinitions", {}) as Promise<{ source: string; policies: CataloguePolicy[] }>).then(
      (v) => ({ ok: true as const, v }),
      (err: Error) => ({ ok: false as const, message: err.message }),
    ),
  ]);

  // Extended rights first: an attribute names its property set by GUID, and a right names the
  // classes it applies to by schemaIDGUID.
  const classByGuid = new Map<string, string>();
  for (const e of classEntries) {
    const guid = first(e, "schemaIDGUID");
    const name = first(e, "lDAPDisplayName");
    if (guid && name) classByGuid.set(guid.toLowerCase(), name);
  }
  const extendedRights: Record<string, CatalogueRight> = {};
  const propertySetByGuid = new Map<string, string>();
  for (const e of rightEntries) {
    const name = first(e, "cn");
    const guid = first(e, "rightsGuid");
    if (!name || !guid) continue;
    const valid = num(e, "validAccesses") ?? 0;
    const kind = valid === 256 ? "control" : valid === 48 ? "propertySet" : valid === 8 ? "validatedWrite" : "other";
    if (kind === "propertySet") propertySetByGuid.set(guid.toLowerCase(), name);
    extendedRights[name] = {
      displayName: first(e, "displayName") ?? name,
      guid,
      kind,
      appliesTo: all(e, "appliesTo").map((g) => classByGuid.get(g.toLowerCase()) ?? g),
    };
  }

  const attributes: Record<string, CatalogueAttribute> = {};
  for (const e of attrEntries) {
    const name = first(e, "lDAPDisplayName");
    if (!name) continue;
    const flags = num(e, "searchFlags") ?? 0;
    const lo = num(e, "rangeLower");
    const hi = num(e, "rangeUpper");
    const set = first(e, "attributeSecurityGUID");
    const linkID = num(e, "linkID");
    attributes[name] = {
      oid: first(e, "attributeID") ?? "",
      ...(first(e, "schemaIDGUID") ? { guid: first(e, "schemaIDGUID") } : {}),
      syntax: syntaxName(first(e, "attributeSyntax") ?? "", first(e, "oMSyntax") ?? ""),
      single: first(e, "isSingleValued") === "TRUE",
      ...(flags & 128 ? { confidential: true as const } : {}),
      ...(flags & 1 ? { indexed: true as const } : {}),
      ...(first(e, "systemOnly") === "TRUE" ? { systemOnly: true as const } : {}),
      ...(linkID !== undefined ? { linkID } : {}),
      ...(lo !== undefined || hi !== undefined ? { range: [lo ?? null, hi ?? null] as [number | null, number | null] } : {}),
      ...(set && propertySetByGuid.has(set.toLowerCase()) ? { propertySet: propertySetByGuid.get(set.toLowerCase()) } : {}),
      ...(first(e, "adminDescription") ? { description: first(e, "adminDescription") } : {}),
    };
  }

  // Classes store only what they add, so must and may are walked up the parents and across the
  // auxiliary classes to give the full list a person means by "what can a user have".
  const raw = new Map<string, Entry>();
  for (const e of classEntries) {
    const name = first(e, "lDAPDisplayName");
    if (name) raw.set(name, e);
  }
  const memo = new Map<string, { must: Set<string>; may: Set<string> }>();
  const collect = (name: string, seen: Set<string>): { must: Set<string>; may: Set<string> } => {
    const cached = memo.get(name);
    if (cached) return cached;
    const out = { must: new Set<string>(), may: new Set<string>() };
    const e = raw.get(name);
    if (!e || seen.has(name)) return out;
    seen.add(name);
    for (const a of [...all(e, "mustContain"), ...all(e, "systemMustContain")]) out.must.add(a);
    for (const a of [...all(e, "mayContain"), ...all(e, "systemMayContain")]) out.may.add(a);
    const parent = first(e, "subClassOf");
    const related = [...(parent && parent !== name ? [parent] : []), ...all(e, "auxiliaryClass"), ...all(e, "systemAuxiliaryClass")];
    for (const r of related) {
      const sub = collect(r, seen);
      sub.must.forEach((a) => out.must.add(a));
      sub.may.forEach((a) => out.may.add(a));
    }
    for (const a of out.must) out.may.delete(a);
    memo.set(name, out);
    return out;
  };
  const kinds = ["88", "structural", "abstract", "auxiliary"] as const;
  const classes: Record<string, CatalogueClass> = {};
  for (const [name, e] of raw) {
    const { must, may } = collect(name, new Set());
    classes[name] = {
      oid: first(e, "governsID") ?? "",
      ...(first(e, "schemaIDGUID") ? { guid: first(e, "schemaIDGUID") } : {}),
      kind: kinds[num(e, "objectClassCategory") ?? 1] ?? "structural",
      parent: first(e, "subClassOf") ?? "",
      must: [...must].sort(),
      may: [...may].sort(),
      auxiliary: [...all(e, "auxiliaryClass"), ...all(e, "systemAuxiliaryClass")].sort(),
      possibleSuperiors: [...all(e, "possSuperiors"), ...all(e, "systemPossSuperiors")].sort(),
      ...(first(e, "adminDescription") ? { description: first(e, "adminDescription") } : {}),
    };
  }

  return {
    domain,
    readAt: now().toISOString(),
    dc: root.dnsHostName?.[0] ?? "",
    schemaNamingContext: schema,
    forestFunctionality: Number(root.forestFunctionality?.[0] ?? 0),
    domainFunctionality: Number(root.domainFunctionality?.[0] ?? 0),
    attributes,
    classes,
    controls: (root.supportedControl ?? []).map((oid) => (CONTROL_NAMES[oid] ? { oid, name: CONTROL_NAMES[oid] } : { oid })),
    extendedRights,
    ...(policyRead.ok
      ? { policies: policyRead.v.policies.map(compactPolicy), policiesSource: policyRead.v.source }
      : { policies: [], policiesError: policyRead.message }),
  };
}

/** Drops the empty fields PowerShell sends as null, so the catalogue the script gets stays small. */
function compactPolicy(p: CataloguePolicy): CataloguePolicy {
  return {
    name: p.name,
    displayName: p.displayName ?? p.name,
    class: p.class,
    key: p.key,
    ...(p.valueName ? { valueName: p.valueName } : {}),
    category: p.category,
    file: p.file,
    elements: (p.elements ?? []).map((e) => ({
      type: e.type,
      ...(e.id ? { id: e.id } : {}),
      ...(e.valueName ? { valueName: e.valueName } : {}),
      ...(e.key ? { key: e.key } : {}),
    })),
  };
}

/**
 * Keeps each domain's catalogue for the session, so the schema is read once per domain. A failed
 * read is not kept, so the next search tries again.
 */
export class CatalogueCache {
  private readonly cache = new Map<string, Promise<Catalogue>>();
  constructor(
    private readonly backend: LdapBackend,
    private readonly read: typeof readCatalogue = readCatalogue,
  ) {}

  get(domain: string, refresh = false): Promise<Catalogue> {
    const key = domain.toLowerCase();
    if (refresh) this.cache.delete(key);
    let p = this.cache.get(key);
    if (!p) {
      p = this.read(this.backend, key);
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }
}
