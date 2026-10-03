/** Type declarations shown to the model in the execute tool description. Keep this short. */
export const BINDING_TYPES = `
declare const ad: {
  // One object by DN, or null if there is none. Default attributes: name, objectClass, sAMAccountName. ["*"] for all.
  get(dn: string, attributes?: string[], opts?: { controls?: Controls }): Promise<Entry | null>;
  // Objects matching an LDAP filter. base defaults to the domain head, scope to "sub", max to 1000 (cap 20000).
  // more is true when there were more than max. Multi-valued attributes like member come back whole.
  search(opts: { filter?: string; base?: string; scope?: "base" | "one" | "sub"; attributes?: string[]; max?: number; controls?: Controls }): Promise<{ entries: Entry[]; more: boolean }>;
  // The account the server runs as, and the PDC emulator it talks to.
  whoami(): Promise<{ user: string; pdc: string; defaultNamingContext: string }>;
  // Writes. A read-mode connection refuses all four before anything is sent.
  add(dn: string, attributes: Record<string, Value | Value[]>): Promise<{ dn: string }>;  // include objectClass
  modify(dn: string, changes: Array<{ op: "add" | "replace" | "delete"; attribute: string; values?: Value | Value[] }>, opts?: { controls?: Controls }): Promise<{ dn: string }>;
  delete(dn: string, opts?: { tree?: boolean }): Promise<{ dn: string }>;
  move(dn: string, to: { newParent?: string; newName?: string }): Promise<{ dn: string }>;  // newName is an RDN, e.g. "CN=New Name"
};
// Group Policy, through Microsoft's GroupPolicy module on the PDC emulator. g is a GPO's name or id.
// A read-mode connection refuses create, delete, link, unlink, set and remove.
declare const gpo: {
  list(): Promise<Gpo[]>;
  // With where it is linked and every registry policy value it sets.
  get(g: string): Promise<Gpo & { links: Link[]; computerSettings: Setting[]; userSettings: Setting[] }>;
  create(name: string, opts?: { comment?: string }): Promise<Gpo>;
  delete(g: string): Promise<{ id: string; name: string; deleted: true }>;
  // Creates the link, or changes it if the GPO is already linked there. target is an OU or the domain DN.
  link(g: string, target: string, opts?: { enabled?: boolean; enforced?: boolean; order?: number }): Promise<{ id: string; links: Link[] }>;
  unlink(g: string, target: string): Promise<{ id: string; links: Link[] }>;
  // key starts with HKLM\\ (computer) or HKCU\\ (user). Find keys with search over catalogue.policies.
  set(g: string, s: { key: string; valueName: string; type: "String" | "ExpandString" | "DWord" | "QWord" | "MultiString"; value: string | number | string[] }): Promise<unknown>;
  remove(g: string, key: string, valueName?: string): Promise<unknown>;
  // Backup-GPO to a folder on the machine adslayer runs on. Allowed on a read connection.
  backup(g: string, path: string): Promise<{ id: string; backupId: string; path: string; timestamp: string }>;
};
interface Gpo { id: string; name: string; status: string; created: string; modified: string; computerVersion: number; userVersion: number; wmiFilter: string | null }
interface Link { target: string; enabled: boolean; enforced: boolean; order: number }
interface Setting { key: string; valueName: string; type: string; value: unknown }
// Every attribute is an array. GUIDs and SIDs are strings; other binary values are { base64 }.
interface Entry { dn: string; attributes: Record<string, Array<string | { base64: string }>> }
type Value = string | number | boolean | { base64: string };
// showDeleted: see and restore objects in the Recycle Bin (CN=Deleted Objects). Restore = modify with it.
interface Controls { showDeleted?: true }
// Calls may run in parallel with Promise.all. Each run may make at most 200 calls.
`.trim();
