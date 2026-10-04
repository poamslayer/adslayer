# Runs spike/gpo-security-write.ps1 on the lab DC from poamslayer/azure-ad-lab: as lab.da (the
# experiments on throwaway GPOs), as lab.delegated (the same on Lab Baseline), then as lab.da again
# to check that nothing is left behind. Issue #13; the results are in docs/adr/0011. Needs az signed
# in and the lab passwords in the macOS Keychain (azure-ad-lab's setup.sh).
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$lab = if ($env:AZURE_AD_LAB) { $env:AZURE_AD_LAB } else { Join-Path (Split-Path -Parent $repo) 'azure-ad-lab' }
$pw = & security find-generic-password -a adlab -s adlab-user -w
$b64 = { param($t) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }
$script = Get-Content -Raw "$PSScriptRoot/gpo-security-write.ps1"

foreach ($step in @(@{ Role = 'da'; Mode = 'da' }, @{ Role = 'delegated'; Mode = 'delegated' }, @{ Role = 'da'; Mode = 'check' })) {
    $name = "gposec-$([guid]::NewGuid().ToString('N').Substring(0,6))"
    $params = @("User=LAB\lab.$($step.Role)", "Password=$pw", "ScriptB64=$(& $b64 $script)", "ArgsB64=$(& $b64 (@{ Mode = $step.Mode } | ConvertTo-Json -Compress))")
    & az vm run-command create -g rg-adlab --vm-name dc01 --name $name --script (Get-Content -Raw "$lab/guest/run-as.ps1") `
        --protected-parameters @params --timeout-in-seconds 1800 --async-execution false -o none 2>$null
    $iv = az vm run-command show -g rg-adlab --vm-name dc01 --name $name --instance-view --query instanceView -o json | ConvertFrom-Json
    az vm run-command delete -g rg-adlab --vm-name dc01 --name $name --yes --no-wait -o none 2>$null
    "########## LAB\lab.$($step.Role), mode $($step.Mode) ($($iv.executionState))"
    $iv.output
    if ($iv.error -and $iv.error -notmatch 'console output buffer') { "ERR: $($iv.error)" }
}
