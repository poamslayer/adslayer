# adslayer

adslayer is an MCP server that lets an AI agent read and change on-premises Active Directory. The agent writes a short JavaScript script, and adslayer runs it in a sandbox against one domain.

adslayer has three main tools, the same as [graphslayer](https://github.com/poamslayer/graphslayer):

- `execute` runs a script against a domain.
- `search` runs a script over the domain's catalogue. The catalogue holds every class and attribute in the schema, the LDAP controls, the extended rights, and the policy settings a GPO can set. adslayer reads the catalogue from the domain the first time you search it and keeps it for the session (ADR-0010).
- `docs` searches Microsoft Learn.

It also has `connections_list`, `connection_add` and `connection_remove`.

## How it works

adslayer runs on a Windows machine that is joined to the domain. Every call runs as the Windows user who is signed in, over Kerberos with signing and sealing. adslayer stores no password and no certificate. What you can do through adslayer is exactly what your Active Directory account can do (ADR-0002).

The Node code has no LDAP client of its own. adslayer starts a PowerShell process, `helper/adslayer-helper.ps1`, and keeps it running. The helper sends each call to the domain's PDC emulator (ADR-0003, ADR-0006).

Each script runs in a workerd isolate with no network access. A script can reach only two objects. The `ad` object reads and writes directory objects. The `gpo` object reads and changes Group Policy objects through Microsoft's GroupPolicy module (ADR-0007).

```js
const r = await ad.search({ base: "OU=Sales,DC=contoso,DC=local", filter: "(objectClass=user)", attributes: ["sAMAccountName"] });
return r.entries.map(e => e.attributes.sAMAccountName[0]);
```

```js
// Turn on "Do not display the lock screen" in a GPO
await gpo.set("Workstation Baseline", { key: "HKLM\\Software\\Policies\\Microsoft\\Windows\\Personalization", valueName: "NoLockScreen", type: "DWord", value: 1 });
```

## Requirements

- Windows, joined to the domain you want to reach. A domain controller works too.
- Node.js 22 or newer.
- Windows PowerShell 5.1, which comes with Windows. adslayer uses PowerShell 7 instead when it is installed.
- Group Policy Management (GPMC), for the `gpo` object. It comes with RSAT, and domain controllers have it.
- The Microsoft Visual C++ Redistributable (x64). Windows Server does not include it, and the sandbox cannot start without it. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe.

## Install

Add this to your MCP client's config:

```json
{
  "mcpServers": {
    "adslayer": {
      "command": "npx",
      "args": ["-y", "adslayer"]
    }
  }
}
```

In Claude Code it is one command:

```powershell
claude mcp add adslayer -- npx -y adslayer
```

## Connections

A connection is one domain, stored with its alias and its mode. It holds no credential.

```powershell
npx -y adslayer connect contoso.local                  # read mode
npx -y adslayer connect contoso.local --alias corp --mode write
npx -y adslayer connections
npx -y adslayer disconnect corp
```

The agent can also add a connection with the `connection_add` tool, in either mode (ADR-0005). If you want a person to decide when writes are allowed, add only read connections and deny `connection_add` calls in your MCP client.

## Writes

A read connection refuses every `add`, `modify`, `delete` and `move`, and every GPO change, before anything is sent. `gpo.backup` is allowed, because it changes nothing in the domain. That mode check is the only limit adslayer puts on a write. A write connection sends whatever the script asks for, and Active Directory permissions decide the rest (ADR-0004).

adslayer does not back anything up, show a preview, or keep its own log. The yoloslayer skills hold those steps. Without them, an agent gets no backup and no preview. Active Directory's own security log, with Directory Service Changes auditing turned on, records each change.

## Where results go

Whatever a script returns goes into the model's context, so it goes to your model provider. With adslayer that is usually directory data, e.g., names and group memberships. Make sure your agreement with the domain's owner covers this (ADR-0009).

## Develop

```sh
npm test          # runs on any OS; LDAP calls go to a fake helper
npm run typecheck
```

`spike/` holds the scripts that test adslayer against the lab domain controller from [azure-ad-lab](https://github.com/poamslayer/azure-ad-lab). `spike/run-on-lab.ps1` tests the helper alone. `spike/run-e2e-on-lab.ps1` installs the packed server on the DC and drives it with a real MCP client.

## License

MIT
