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

`gpo.get` also returns a GPO's security settings: password and lockout policy, user rights, Security Options, Restricted Groups and audit policy. `gpo.grant` and `gpo.revoke` change who holds a user right, one account at a time, and `gpo.setSecurity` changes one password, lockout or Security Options value (ADR-0011). A GPO that defines a user right replaces the whole list on the computers it applies to, and a computer keeps a right after a GPO stops setting it.

## Installation

Follow these steps in order on the Windows machine where your AI agent runs. Each step says how to check it and how to fix it. Run the commands in PowerShell as yourself, not as an administrator, except where a step says otherwise.

### Before you start

- The machine has to be a member of the domain you want to reach. A domain controller works too.
- adslayer acts as the Windows user who is signed in. Sign in as the user whose Active Directory rights you want your AI agent to have. adslayer never asks for a password.
- Steps 2 to 4 may need an administrator, because they install software.

### 1. Check that the machine is on the domain

```powershell
(Get-CimInstance Win32_ComputerSystem).Domain
```

This should print your domain's DNS name, for example `contoso.local`. If it prints `WORKGROUP`, the machine is not joined to a domain, and adslayer cannot work on it.

### 2. Install Node.js 22 or newer

Check:

```powershell
node --version
```

If this prints `v22` or higher, go to step 3. If it prints an error or a lower version, install Node.js LTS. Then close PowerShell, open it again, and check again.

```powershell
winget install OpenJS.NodeJS.LTS
```

### 3. Install the Microsoft Visual C++ Redistributable

adslayer runs each script in a sandbox, and the sandbox cannot start without this runtime. Windows Server does not include it.

Check:

```powershell
Test-Path "$env:SystemRoot\System32\vcruntime140_1.dll"
```

If this prints `True`, go to step 4. If it prints `False`, install it with the command below, or download it from https://aka.ms/vs/17/release/vc_redist.x64.exe.

```powershell
winget install Microsoft.VCRedist.2015+.x64
```

### 4. Install Group Policy Management

adslayer needs this to read and change GPOs. Domain controllers already have it.

Check:

```powershell
Test-Path "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules\GroupPolicy"
```

If this prints `True`, go to step 5. If it prints `False`, open PowerShell as administrator and run the command for your version of Windows.

On Windows 10 or 11:

```powershell
Add-WindowsCapability -Online -Name Rsat.GroupPolicy.Management.Tools~~~~0.0.1.0
```

On Windows Server:

```powershell
Install-WindowsFeature GPMC
```

You do not need to install PowerShell. adslayer uses Windows PowerShell 5.1, which comes with Windows, or PowerShell 7 if you have it.

### 5. Add your domain

```powershell
npx -y adslayer connect contoso.local
```

Use your own domain name from step 1. This adds the domain in read mode, so the agent can read but not change anything. The first run downloads adslayer from npm before it adds the domain. It should print `Added "contoso.local" (contoso.local), mode read`.

To let the agent make changes too, add the domain in write mode. See [Connections](#connections) before you do.

```powershell
npx -y adslayer connect contoso.local --alias contoso-write --mode write
```

### 6. Add adslayer to your AI agent

For Claude Code, run:

```powershell
claude mcp add adslayer -- npx -y adslayer
```

For Claude Desktop and other AI agents, add this to the agent's config file. For Claude Desktop on Windows, the file is `%APPDATA%\Claude\claude_desktop_config.json`.

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

Then restart your AI agent.

### 7. Check that it works

Ask your AI agent:

> Use adslayer to run `return await ad.whoami();` against contoso.local.

The answer should show your own account, for example `u:CONTOSO\jane`, and the name of the domain controller that adslayer sends its calls to. If it shows an error, see [Problems](#problems).

### Problems

| What you see | What to do |
|---|---|
| `adslayer reaches Active Directory only from a Windows machine joined to the domain` | Run adslayer on Windows, on a machine joined to the domain. See step 1. |
| `The script sandbox (workerd) cannot start because the Microsoft Visual C++ Redistributable (x64) is not installed` | Do step 3, then restart your AI agent. |
| `No connection named "..."` | Do step 5. Run `npx -y adslayer connections` to see the domains you added. |
| `GroupPolicyModuleMissing: The GroupPolicy module is not installed` | Do step 4, then restart your AI agent. |
| `InsufficientAccessRights` or `AccessDenied` | Active Directory refused the change for your account. adslayer can do only what your account can do. |
| Your AI agent does not list the adslayer tools | Restart your AI agent. In Claude Code, run `claude mcp list` to check that adslayer is there. |

### Update

`npx` keeps a copy of adslayer and may keep using it after a new version comes out. To get the newest version, close your AI agent, delete the folder `%LOCALAPPDATA%\npm-cache\_npx`, and start the agent again.

## Uninstall

Follow these steps on the machine where you installed adslayer. Uninstalling changes nothing in Active Directory. adslayer adds nothing to the domain itself, and any changes your AI agent made through adslayer stay in place.

### 1. Remove adslayer from your AI agent

For Claude Code, run:

```powershell
claude mcp remove adslayer
```

Then run `claude mcp list`. adslayer should no longer be in the list.

For Claude Desktop and other AI agents, open the agent's config file and delete the `"adslayer"` entry under `mcpServers`. For Claude Desktop on Windows, the file is `%APPDATA%\Claude\claude_desktop_config.json`. Then restart your AI agent.

### 2. Delete your list of domains

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.adslayer"
```

This folder holds only the domains you added with `connect`. It holds no passwords.

### 3. Delete the copy that npx downloaded

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_npx"
```

This deletes every package that `npx` has downloaded, not only adslayer. For any other tool that runs through `npx`, npx downloads it again the next time it runs.

### 4. Delete GPO backups, if you made any

`gpo.backup` writes each backup to the folder on this machine that the script named. adslayer does not keep a list of these folders. A backup folder holds a `manifest.xml` file and one folder per GPO, named by the GPO's id in braces. Delete a backup only if you no longer need it, because it is the only way to restore that GPO to the state it was in.

### 5. Decide whether to keep the software from installation steps 2 to 4

Other programs on this machine may use Node.js, the Visual C++ Redistributable or Group Policy Management. Keep them unless you installed them only for adslayer. To remove them, run PowerShell as administrator.

```powershell
winget uninstall OpenJS.NodeJS.LTS
winget uninstall Microsoft.VCRedist.2015+.x64
```

To remove Group Policy Management on Windows 10 or 11, run:

```powershell
Remove-WindowsCapability -Online -Name Rsat.GroupPolicy.Management.Tools~~~~0.0.1.0
```

On Windows Server, run `Uninstall-WindowsFeature GPMC`. Do not remove it from a domain controller, because the people who manage the domain use it there.

## Connections

A connection is one domain, stored with its alias and its mode in `%USERPROFILE%\.adslayer\connections.json`. It holds no password.

```powershell
npx -y adslayer connect contoso.local                  # read mode
npx -y adslayer connect contoso.local --alias corp --mode write
npx -y adslayer connections
npx -y adslayer disconnect corp
```

The agent can also add a connection with the `connection_add` tool, in either mode (ADR-0005). If you want a person to decide when writes are allowed, add only read connections and deny `connection_add` calls in your MCP client.

## Writes

A read connection refuses every `add`, `modify`, `delete`, `move`, `addAce` and `removeAce`, and every GPO change, before anything is sent. It can still read permissions with `getAcl`. `gpo.backup` is allowed, because it changes nothing in the domain. That mode check is the only limit adslayer puts on a write. A write connection sends whatever the script asks for, and Active Directory permissions decide the rest (ADR-0004).

To bring back a deleted object, a script finds it in the Recycle Bin with `ad.search` and the `showDeleted` control, then restores it with `ad.modify` and the same control. A read connection can find deleted objects but cannot restore them.

adslayer does not back anything up, show a preview, or keep its own log. The dont-nuke-prod skills hold those steps. Without them, an agent gets no backup and no preview. Active Directory's own security log, with Directory Service Changes auditing turned on, records each change.

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
