# Helper spike (#4)

`drive.mjs` drives `helper/adslayer-helper.ps1` the way the Node server will: it spawns the helper, sends JSON lines, and checks the answers against the lab domain from [azure-ad-lab](https://github.com/poamslayer/azure-ad-lab).

```sh
az vm start -g rg-adlab -n dc01
pwsh spike/run-on-lab.ps1                 # both users, PowerShell 7 and 5.1
pwsh spike/run-on-lab.ps1 -Roles delegated
az vm deallocate -g rg-adlab -n dc01
```

On the DC itself: `node spike/drive.mjs <pwsh.exe or powershell.exe> helper/adslayer-helper.ps1 <da|delegated>`.

## End to end (#6)

`run-e2e-on-lab.ps1` packs adslayer as npm would ship it, installs it on the DC, and runs `e2e-mcp.mjs` as `lab.da` and `lab.delegated`. `e2e-mcp.mjs` is a real MCP client. It starts the server over stdio, adds a read and a write connection, and runs scripts through `execute`.

```sh
pwsh spike/run-e2e-on-lab.ps1
```

## Writing GPO security settings (#13)

`run-gpo-security-write.ps1` runs `gpo-security-write.ps1` on the DC three times: as `lab.da` on throwaway `adslayer-proto-*` GPOs, as `lab.delegated` on Lab Baseline, and as `lab.da` again to check that nothing is left. It compares two ways of writing `GptTmpl.inf`: back up, edit, `Import-GPO`, against a direct edit with version and extension bookkeeping. The results are in ADR-0011. The script also puts the DC's `SeTimeZonePrivilege` back afterwards, because a user right from a deleted GPO stays set.

```sh
pwsh spike/run-gpo-security-write.ps1
```

## The concurrent-edit guard (#16)

`run-gpo-security-guard.ps1` stages the helper on the DC and runs `gpo-security-guard.ps1` as `lab.da`. That script loads the helper's functions and calls `Write-GpoSecurity` with its `-BeforeVersionBump` hook. The hook stands for someone else saving the GPO in the middle of adslayer's write. The script checks that the write is refused and that the template is left as it should be (ADR-0011, guardrail 6).

```sh
pwsh spike/run-gpo-security-guard.ps1
```

## What the existing calls can already do (#24 to #27)

`lab-checks.mjs` checks four changes that have no call of their own. It does each change through the real server, then looks at the result with Windows' own tools. The four changes are:

- a password reset with `ad.modify` on `unicodePwd`
- a WMI filter made with `ad.add` and set with `ad.modify` on `gPCWQLFilter`
- a GPO rename with `ad.modify` on `displayName`, compared with `Rename-GPO`
- Windows Firewall profile settings and a rule written with `gpo.set`, compared with what `New-NetFirewallRule` writes

It runs through the e2e runner. run-command returns only the last 4 KB of output, so the script prints short results and writes the full notes to a file in the user's temp folder on the DC.

```sh
pwsh spike/run-e2e-on-lab.ps1 -Script lab-checks.mjs
```
