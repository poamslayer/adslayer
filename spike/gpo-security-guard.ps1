# Issue #16, ADR-0011 guardrail 6: a write that loses a race with someone else's edit changes
# nothing. Runs on the lab DC as lab.da through spike/run-gpo-security-guard.ps1. Loads the real
# helper's functions (not its read loop) and calls Write-GpoSecurity with -BeforeVersionBump, which
# stands for someone else editing the GPO between adslayer writing the file and raising the version.
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText('C:\adslayer-spike\helper\adslayer-helper.ps1')
. ([scriptblock]::Create($source.Substring(0, $source.IndexOf('# --- Loop'))))
Import-Module ActiveDirectory -WarningAction SilentlyContinue

$domain = (Get-ADDomain).DNSRoot
function Say([bool]$ok, [string]$name, [string]$detail) { "{0} {1} -- {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail }

$name = "adslayer-guard-$([guid]::NewGuid().ToString('N').Substring(0,6))"
$t = Get-GpoTarget @{ domain = $domain; gpo = (New-GPO -Name $name -Domain $domain -Server (Get-Connection $domain).Pdc).Id.ToString() }
$state = { Get-GpoSecurityState $t }
# Someone else saving the GPO: both versions up by one, as GPMC would leave them.
$otherEdit = {
    $s = & $state
    Set-ADObject $s.GpcDn -Server $t.Server -Replace @{ versionNumber = $s.Version + 1 }
    [IO.File]::WriteAllText($s.IniPath, "[General]`r`nVersion=$($s.Version + 1)`r`n", [Text.Encoding]::ASCII)
}
function Try-Write([scriptblock]$change, [scriptblock]$hook) {
    try { Write-GpoSecurity $t $change -BeforeVersionBump $hook | Out-Null; 'written' }
    catch { $ex = Get-InnerException $_.Exception; if ($ex -is [HelperError]) { $ex.Code } else { $ex.Message } }
}
# Script blocks written out, not built with GetNewClosure: a closure can't see the functions loaded above.
$set10 = { param($x) Set-InfValue $x 'System Access' 'MinimumPasswordLength' '10' }
$set12 = { param($x) Set-InfValue $x 'System Access' 'MinimumPasswordLength' '12' }
$set14 = { param($x) Set-InfValue $x 'System Access' 'MinimumPasswordLength' '14' }

try {
    # 1. No template yet. Someone else saves the GPO mid-write.
    $r = Try-Write $set12 $otherEdit
    $s = & $state
    Say ($r -eq 'GpoChanged' -and -not $s.InfExists) 'a write that loses the race is refused, and the template it created is removed' "result $r; template exists: $($s.InfExists)"

    # 2. A template exists. Someone else saves the GPO mid-write; the old template comes back.
    $r0 = Try-Write $set10 $null
    $old = (& $state).Text
    $r = Try-Write $set12 $otherEdit
    $s = & $state
    Say ($r0 -eq 'written' -and $r -eq 'GpoChanged' -and $s.Text -ceq $old) 'with a template already there, the old template is written back' "first write $r0; result $r; MinimumPasswordLength now $(Get-InfValue $s.Text 'System Access' 'MinimumPasswordLength')"

    # 3. Someone else also writes the template. Theirs stays.
    $theirs = Set-InfValue $old 'System Access' 'LockoutBadCount' '5'
    $r = Try-Write $set12 { & $otherEdit; [IO.File]::WriteAllText((& $state).InfPath, $theirs, [Text.Encoding]::Unicode) }
    $s = & $state
    Say ($r -eq 'GpoChanged' -and $s.Text -ceq $theirs) "when someone else also wrote the template, theirs is kept" "result $r; LockoutBadCount $(Get-InfValue $s.Text 'System Access' 'LockoutBadCount')"

    # 4. Versions still agree after all that, so the next write goes through.
    $r = Try-Write $set14 $null
    $s = & $state
    Say ($r -eq 'written' -and $s.Version -eq $s.IniVersion -and (Get-InfValue $s.Text 'System Access' 'MinimumPasswordLength') -eq '14') 'after the refusals, a normal write goes through with the versions in step' "ad $($s.Version) ini $($s.IniVersion)"
} finally {
    Remove-GPO -Guid $t.Gpo.Id -Domain $domain -Server $t.Server
    Say (-not (Get-GPO -Name $name -Domain $domain -ErrorAction SilentlyContinue)) 'cleanup: the test GPO is deleted' $name
}
