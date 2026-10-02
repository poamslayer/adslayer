# Packs adslayer as npm would ship it, installs it on the lab DC from poamslayer/azure-ad-lab, and
# runs spike/e2e-mcp.mjs as lab.da and lab.delegated. Staging runs as SYSTEM inside the script
# body (protected parameters ride on a command line, which Windows caps at 32 KB); each user then
# runs through azure-ad-lab's guest/run-as.ps1. Needs az signed in, the DC running, and the lab
# passwords in the macOS Keychain (azure-ad-lab's setup.sh).
param([string[]]$Roles = @('da', 'delegated'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$lab = if ($env:AZURE_AD_LAB) { $env:AZURE_AD_LAB } else { Join-Path (Split-Path -Parent $repo) 'azure-ad-lab' }
$pw = & security find-generic-password -a adlab -s adlab-user -w

function Invoke-Rc([string]$Script, [string[]]$Params = @()) {
    $name = "e2e-$([guid]::NewGuid().ToString('N').Substring(0,6))"
    $azArgs = @('vm', 'run-command', 'create', '-g', 'rg-adlab', '--vm-name', 'dc01', '--name', $name, '--script', $Script,
        '--timeout-in-seconds', '1800', '--async-execution', 'false', '-o', 'none')
    if ($Params) { $azArgs += '--protected-parameters'; $azArgs += $Params }
    & az @azArgs 2>$null
    $iv = az vm run-command show -g rg-adlab --vm-name dc01 --name $name --instance-view --query instanceView -o json | ConvertFrom-Json
    az vm run-command delete -g rg-adlab --vm-name dc01 --name $name --yes --no-wait -o none 2>$null
    $iv
}

Push-Location $repo
try {
    npm run build | Out-Null
    $tgz = (npm pack --silent | Select-Object -Last 1).Trim()
    $tgzB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $repo $tgz)))
    Remove-Item (Join-Path $repo $tgz)
} finally { Pop-Location }
$e2eB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'e2e-mcp.mjs')))

$stage = @"
`$ErrorActionPreference = 'Stop'
`$dir = 'C:\adslayer-e2e'
if (Test-Path `$dir) { Remove-Item `$dir -Recurse -Force }
New-Item -ItemType Directory -Force -Path `$dir | Out-Null
[IO.File]::WriteAllBytes("`$dir\$tgz", [Convert]::FromBase64String('$tgzB64'))
[IO.File]::WriteAllBytes("`$dir\e2e-mcp.mjs", [Convert]::FromBase64String('$e2eB64'))
`$env:Path = "`$env:ProgramFiles\nodejs;`$env:Path"
Set-Location `$dir
'{"name":"adslayer-e2e","private":true,"type":"module"}' | Set-Content package.json -Encoding Ascii
# Through cmd, so npm's notices on stderr are text and not PowerShell 5.1 errors under Stop.
cmd.exe /c "npm.cmd install --no-audit --no-fund .\$tgz 2>&1" | Select-Object -Last 3
icacls.exe `$dir /grant 'Users:(OI)(CI)RX' | Out-Null
if (Test-Path "`$dir\node_modules\adslayer\dist\cli\main.js") { 'STAGED' } else { 'NOT_STAGED' }
"@
$iv = Invoke-Rc $stage
$iv.output
if ($iv.output -notmatch 'STAGED' -or $iv.output -match 'NOT_STAGED') { throw "staging failed: $($iv.executionState) $($iv.error)" }

foreach ($role in $Roles) {
    $inner = @"
`$env:Path = "`$env:ProgramFiles\nodejs;`$env:Path"
& "`$env:ProgramFiles\nodejs\node.exe" C:\adslayer-e2e\e2e-mcp.mjs C:\adslayer-e2e\node_modules\adslayer\dist\cli\main.js '$role' 2>&1 | ForEach-Object { "`$_" }
"@
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($inner))
    $iv = Invoke-Rc (Get-Content -Raw "$lab/guest/run-as.ps1") @("User=LAB\lab.$role", "Password=$pw", "ScriptB64=$b64", 'ArgsB64=e30=')
    "########## LAB\lab.$role ($($iv.executionState))"
    $iv.output
    if ($iv.error -and $iv.error -notmatch 'console output buffer') { "ERR: $($iv.error)" }
}
