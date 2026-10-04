# Runs spike/gpo-security-guard.ps1 on the lab DC from poamslayer/azure-ad-lab as lab.da. Stages the
# helper as SYSTEM inside the script body first, because it is too big for a protected parameter
# (Windows caps a command line at 32 KB). Issue #16; ADR-0011 guardrail 6. Needs az signed in and
# the lab passwords in the macOS Keychain (azure-ad-lab's setup.sh).
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$lab = if ($env:AZURE_AD_LAB) { $env:AZURE_AD_LAB } else { Join-Path (Split-Path -Parent $repo) 'azure-ad-lab' }
$pw = & security find-generic-password -a adlab -s adlab-user -w
$b64 = { param($t) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }

function Invoke-Rc([string]$Script, [string[]]$Params = @()) {
    $name = "guard-$([guid]::NewGuid().ToString('N').Substring(0,6))"
    $azArgs = @('vm', 'run-command', 'create', '-g', 'rg-adlab', '--vm-name', 'dc01', '--name', $name, '--script', $Script,
        '--timeout-in-seconds', '1800', '--async-execution', 'false', '-o', 'none')
    if ($Params) { $azArgs += '--protected-parameters'; $azArgs += $Params }
    & az @azArgs 2>$null
    $iv = az vm run-command show -g rg-adlab --vm-name dc01 --name $name --instance-view --query instanceView -o json | ConvertFrom-Json
    az vm run-command delete -g rg-adlab --vm-name dc01 --name $name --yes --no-wait -o none 2>$null
    $iv
}

$stage = @"
New-Item -ItemType Directory -Force -Path 'C:\adslayer-spike\helper' | Out-Null
[IO.File]::WriteAllText('C:\adslayer-spike\helper\adslayer-helper.ps1', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(& $b64 (Get-Content -Raw "$repo/helper/adslayer-helper.ps1"))')))
icacls.exe 'C:\adslayer-spike' /grant 'Users:(OI)(CI)RX' | Out-Null
'STAGED'
"@
$iv = Invoke-Rc $stage
if ($iv.output -notmatch 'STAGED') { throw "staging failed: $($iv.executionState) $($iv.error)" }

$iv = Invoke-Rc (Get-Content -Raw "$lab/guest/run-as.ps1") @('User=LAB\lab.da', "Password=$pw", "ScriptB64=$(& $b64 (Get-Content -Raw "$PSScriptRoot/gpo-security-guard.ps1"))", 'ArgsB64=e30=')
"########## LAB\lab.da ($($iv.executionState))"
$iv.output
if ($iv.error -and $iv.error -notmatch 'console output buffer') { "ERR: $($iv.error)" }
