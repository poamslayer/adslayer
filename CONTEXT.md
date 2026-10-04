# adslayer

An MCP server that lets an AI agent read from and write to on-premises Active Directory. It has the same three tools as graphslayer. `docs` searches Microsoft Learn, `search` runs a script over the catalogue, and `execute` runs a script against a domain. The server is the hands. Judgment about when and how to change a domain lives in the yoloslayer skills.

## Language

### Directory

**Domain**:
One Active Directory domain, named by its DNS name, e.g., `contoso.local`. Every `execute` call runs against exactly one domain.
_Avoid_: Tenant (that is Entra ID), directory, environment

**Forest**:
The set of domains that share one schema and one configuration partition. A forest can hold several domains, and each domain needs its own connection.
_Avoid_: Tree, org

**Object**:
One entry in a domain, e.g., a user, a group, a computer, an OU or a GPO. Every object has a DN.
_Avoid_: Entry, record, item

**DN**:
The distinguished name of an object, which is its full path in the domain, e.g., `CN=Jane Doe,OU=Sales,DC=contoso,DC=local`. A script names an object by its DN.
_Avoid_: Path, LDAP path, ADsPath

**Attribute**:
One named field on an object, e.g., `sAMAccountName` or `member`. An attribute holds one value or many values, as the schema says.
_Avoid_: Property, field

**Schema**:
The forest's list of object classes and attributes, with each attribute's syntax and whether it holds one value or many.
_Avoid_: Data model

**DACL**:
The list of permissions on an object, i.e., who is allowed or denied what. It is part of the object's security descriptor, with the owner. adslayer reads it with `ad.getAcl` and changes it one ACE at a time.
_Avoid_: Permissions list, ACL (an ACL can also be the audit list, the SACL, which adslayer does not touch)

**ACE**:
One entry in a DACL: a principal, allow or deny, the rights, and optionally the attribute, class or extended right it covers and how it is inherited. An inherited ACE lives on a parent and can be changed only there.
_Avoid_: Permission entry, rule

**PDC emulator**:
The one domain controller in each domain that holds the PDC emulator role. Every call from adslayer goes to it. ADR-0006.
_Avoid_: Primary DC, the DC

**Recycle Bin**:
The Active Directory feature that keeps a deleted object so a person can restore it with its attributes. It is off unless someone in the forest turned it on.
_Avoid_: Trash, tombstone (a tombstone is what is left when the Recycle Bin is off)

### Group Policy

**GPO**:
A Group Policy object. It is an object in the domain and a folder of settings in SYSVOL.
_Avoid_: Policy (too broad), group policy (the feature, not one object)

**GPO link**:
The tie between a GPO and an OU, a domain or a site. A GPO applies only where it is linked.
_Avoid_: Assignment, scope

**Policy setting**:
One registry-based setting inside a GPO, i.e., what the Administrative Templates in the Group Policy editor show. These are the settings adslayer can change. ADR-0007.
_Avoid_: Preference, rule

**Security settings**:
The settings in a GPO's security template, `GptTmpl.inf`: password and lockout policy, user rights, Security Options, Restricted Groups and audit policy. adslayer edits the file itself, under guardrails, because the GroupPolicy module can't. ADR-0011.
_Avoid_: Security policy (too broad), security template (the file, not its settings)

**Tattooing**:
A computer keeping a setting after the GPO that set it stops setting it. User rights do this: removing a right from a GPO, or deleting the GPO, leaves the computers as they were until another GPO sets the right. Undoing a change means setting the old value, not removing the new one.
_Avoid_: Sticky setting, residue

### The server

**Connection**:
One domain that the server can reach, stored by the server with its mode. A connection holds no credential, because every call runs as the logged-on user. It is a stored record, not a network connection.
_Avoid_: Account, session, tenant

**Alias**:
The short name a person gives a connection. The domain argument of a tool accepts an alias or the domain's DNS name.
_Avoid_: Name, label

**Mode**:
Whether a connection is read or write. A read connection refuses every add, modify, delete, move, ACL change and GPO change before anything is sent. The mode is the only limit the server puts on a write. ADR-0004.
_Avoid_: Template, permission level

**Logged-on user**:
The Windows user who is signed in where the server runs. Every call runs as this user through Kerberos, so the user's Active Directory permissions are what the domain enforces. ADR-0002.
_Avoid_: Service account, principal, caller

**Catalogue**:
The data `search` runs over. It holds the schema, the LDAP controls and the extended rights of one domain. The server reads it from the domain the first time `search` names that domain, and keeps it for the session. ADR-0010.
_Avoid_: Index (that is graphslayer's word for its Graph data), metadata

**Catalogue refresh**:
Reading a domain's catalogue again within a session, e.g., after a schema extension. `search` does this when it is called with `refresh: true`.
_Avoid_: Sync, update

### Around the server

**yoloslayer**:
The skill stack that tells an agent how to make a change safely in Microsoft 365 and Active Directory. Its steps include impact analysis, a saved before state, a preview, and a record of the change. It is a separate repo. ADR-0004.
_Avoid_: slaystack-m365 (its old name), guardrails, policy
