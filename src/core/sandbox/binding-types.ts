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
  // Writes. A read-mode connection refuses these four before anything is sent.
  add(dn: string, attributes: Record<string, Value | Value[]>): Promise<{ dn: string }>;  // include objectClass
  modify(dn: string, changes: Array<{ op: "add" | "replace" | "delete"; attribute: string; values?: Value | Value[] }>, opts?: { controls?: Controls }): Promise<{ dn: string }>;
  delete(dn: string, opts?: { tree?: boolean }): Promise<{ dn: string }>;
  move(dn: string, to: { newParent?: string; newName?: string }): Promise<{ dn: string }>;  // newName is an RDN, e.g. "CN=New Name"
  // Permissions. getAcl reads the owner and DACL, which needs no admin rights. A read-mode connection refuses addAce and removeAce.
  getAcl(dn: string): Promise<{ dn: string; owner: Principal; protected: boolean; aces: Ace[] }>;
  // objectType: an attribute, class or extended right name (find it with search) or a GUID. inheritedObjectType: a class.
  addAce(dn: string, ace: NewAce): Promise<{ dn: string }>;
  // Removes the entry that matches exactly; an Ace from getAcl can be passed back as it is. removed is false if none matched.
  removeAce(dn: string, ace: NewAce | Ace): Promise<{ dn: string; removed: boolean }>;
};
// Group Policy, through Microsoft's GroupPolicy module on the PDC emulator. g is a GPO's name or id.
// A read-mode connection refuses create, delete, link, unlink, set, remove, grant, revoke and setSecurity.
declare const gpo: {
  list(): Promise<Gpo[]>;
  // With where it is linked and every registry policy value it sets.
  get(g: string): Promise<Gpo & { links: Link[]; computerSettings: Setting[]; userSettings: Setting[]; securitySettings: SecuritySettings }>;
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
  // Security settings (GptTmpl.inf, ADR-0011). Each changes one thing and answers with what was there before.
  // A GPO that defines a user right REPLACES the whole list on the computers it applies to. So granting on a right
  // the GPO doesn't define yet (defined: "new") leaves only that principal: grant everyone who should keep it.
  // Revoking the last principal undefines the right (defined: false); computers keep their last list until another GPO sets it.
  grant(g: string, right: string, principal: string): Promise<RightChange>;   // right e.g. "SeServiceLogonRight"; principal "CONTOSO\\svc-web" or a SID
  revoke(g: string, right: string, principal: string): Promise<RightChange>;
  setSecurity(g: string, section: "System Access", key: string, value: number | string): Promise<SecurityChange>;   // e.g. "MinimumPasswordLength", 14
  setSecurity(g: string, section: "Registry Values", key: string, value: { type: 1 | 2 | 4 | 7; value: number | string | string[] }): Promise<SecurityChange>;  // key MACHINE\\...
};
interface Gpo { id: string; name: string; status: string; created: string; modified: string; computerVersion: number; userVersion: number; wmiFilter: string | null }
interface Link { target: string; enabled: boolean; enforced: boolean; order: number }
interface Setting { key: string; valueName: string; type: string; value: unknown }
// From the GPO's security template (GptTmpl.inf). Empty when the GPO sets none.
interface SecuritySettings {
  systemAccess: Record<string, number | string>;     // password and lockout policy, e.g. MinimumPasswordLength, LockoutBadCount
  eventAudit: Record<string, number | string>;
  privilegeRights: Record<string, GpoPrincipal[]>;   // user rights, e.g. SeInteractiveLogonRight
  groupMembership: Array<{ group: GpoPrincipal; members?: GpoPrincipal[]; memberOf?: GpoPrincipal[] }>;  // Restricted Groups
  registryValues: Record<string, { type: number; value: number | string }>;  // Security Options, keyed MACHINE\\...
  other: Record<string, Record<string, string>>;
}
interface GpoPrincipal { sid: string | null; name: string | null }
interface RightChange { id: string; right: string; principal: GpoPrincipal; changed: boolean; defined: boolean | "new"; before: GpoPrincipal[]; after: GpoPrincipal[] }
interface SecurityChange { id: string; section: string; key: string; changed: boolean; before: unknown; after: unknown }
// Every attribute is an array. GUIDs and SIDs are strings; other binary values are { base64 }.
interface Entry { dn: string; attributes: Record<string, Array<string | { base64: string }>> }
type Value = string | number | boolean | { base64: string };
interface Principal { sid: string; name: string | null }   // name e.g. "CONTOSO\\Helpdesk"
// rights: e.g. "GenericAll", "ReadProperty", "WriteProperty", "ExtendedRight", "CreateChild", "DeleteChild", "Delete", "DeleteTree", "WriteDacl"
// inheritance: "All" = this object and everything below it; "Descendents" = only below it.
type Inheritance = "None" | "All" | "Descendents" | "SelfAndChildren" | "Children";
interface Ace { principal: Principal; type: "allow" | "deny"; rights: string[]; objectType?: string; inheritedObjectType?: string; inheritance: Inheritance; inherited: boolean }
interface NewAce { principal: string; type: "allow" | "deny"; rights: string[]; objectType?: string; inheritedObjectType?: string; inheritance?: Inheritance }  // principal: "CONTOSO\\Helpdesk" or a SID
// showDeleted: see and restore objects in the Recycle Bin (CN=Deleted Objects). Restore = modify with it.
interface Controls { showDeleted?: true }
// Calls may run in parallel with Promise.all. Each run may make at most 200 calls.
`.trim();
