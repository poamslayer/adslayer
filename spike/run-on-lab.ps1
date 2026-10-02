# Runs spike/drive.mjs on the lab DC from poamslayer/azure-ad-lab, as lab.da and lab.delegated, on
# PowerShell 7 and 5.1. Stages the files as SYSTEM inside the script body (a protected parameter
# reaches PowerShell on its command line, which Windows caps at 32 KB), then runs the driver as
# each user through azure-ad-lab's guest/run-as.ps1. Needs az signed in and the lab passwords in
# the macOS Keychain (azure-ad-lab's setup.sh).
param([string[]]$Roles = @('da', 'delegated'), [string[]]$Shells = @('C:\Program Files\PowerShell\7\pwsh.exe', 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$lab = if ($env:AZURE_AD_LAB) { $env:AZURE_AD_LAB } else { Join-Path (Split-Path -Parent $repo) 'azure-ad-lab' }
$pw = & security find-generic-password -a adlab -s adlab-user -w
$b64 = { param($t) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }

function Invoke-Rc([string]$Script, [string[]]$Params = @()) {
    $name = "spike-$([guid]::NewGuid().ToString('N').Substring(0,6))"
    $azArgs = @('vm', 'run-command', 'create', '-g', 'rg-adlab', '--vm-name', 'dc01', '--name', $name, '--script', $Script,
        '--timeout-in-seconds', '1800', '--async-execution', 'false', '-o', 'none')
    if ($Params) { $azArgs += '--protected-parameters'; $azArgs += $Params }
    & az @azArgs 2>$null
    $iv = az vm run-command show -g rg-adlab --vm-name dc01 --name $name --instance-view --query instanceView -o json | ConvertFrom-Json
    az vm run-command delete -g rg-adlab --vm-name dc01 --name $name --yes --no-wait -o none 2>$null
    $iv
}

$stage = @"
`$dir = 'C:\adslayer-spike'
New-Item -ItemType Directory -Force -Path "`$dir\helper", "`$dir\spike" | Out-Null
[IO.File]::WriteAllText("`$dir\helper\adslayer-helper.ps1", [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(& $b64 (Get-Content -Raw "$repo/helper/adslayer-helper.ps1"))')))
[IO.File]::WriteAllText("`$dir\spike\drive.mjs", [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(& $b64 (Get-Content -Raw "$repo/spike/drive.mjs"))')))
icacls.exe `$dir /grant 'Users:(OI)(CI)RX' | Out-Null
'STAGED'
"@
$iv = Invoke-Rc $stage
if ($iv.output -notmatch 'STAGED') { throw "staging failed: $($iv.executionState) $($iv.error)" }

foreach ($role in $Roles) {
    $inner = @"
`$node = "`$env:ProgramFiles\nodejs\node.exe"
foreach (`$ps in $(($Shells | ForEach-Object { "'$_'" }) -join ", ")) {
    "===== `$ps"
    & `$node C:\adslayer-spike\spike\drive.mjs `$ps C:\adslayer-spike\helper\adslayer-helper.ps1 '$role' 2>&1 | ForEach-Object { "`$_" }
}
"@
    $iv = Invoke-Rc (Get-Content -Raw "$lab/guest/run-as.ps1") @("User=LAB\lab.$role", "Password=$pw", "ScriptB64=$(& $b64 $inner)", 'ArgsB64=e30=')
    "########## LAB\lab.$role ($($iv.executionState))"
    $iv.output
    if ($iv.error -and $iv.error -notmatch 'console output buffer') { "ERR: $($iv.error)" }
}
