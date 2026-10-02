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
