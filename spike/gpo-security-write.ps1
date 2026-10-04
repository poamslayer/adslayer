# Issue #13: how should adslayer write a GPO's security settings (GptTmpl.inf)? Runs on the lab DC
# as a lab user, through spike/run-gpo-security-write.ps1. Prints one PASS/FAIL/INFO line per
# question. The answers are recorded in docs/adr/0011.
#
#   -Mode da         path A (Backup-GPO, edit the backup, Import-GPO) and path B (direct edit) on
#                    throwaway GPOs named adslayer-proto-*, linked to OU=Domain Controllers
#   -Mode delegated  both paths on Lab Baseline, which lab.delegated can edit but not create;
#                    restores Lab Baseline from a backup taken first
#   -Mode check      as lab.da: no adslayer-proto-* GPO is left, and Lab Baseline is as it was
#
# The setting is SeTimeZonePrivilege ("Change the time zone"), granted to Remote Desktop Users on
# top of whoever holds it now. A GPO that defines a user right replaces the whole list, so the
# current holders are read first and kept.
param([ValidateSet('da', 'delegated', 'check')][string]$Mode = 'da')
$ErrorActionPreference = 'Stop'
Import-Module GroupPolicy -WarningAction SilentlyContinue
Import-Module ActiveDirectory -WarningAction SilentlyContinue

$domain = (Get-ADDomain).DNSRoot
$dn = (Get-ADDomain).DistinguishedName
$server = (Get-ADDomain).PDCEmulator
$dcOu = "OU=Domain Controllers,$dn"
$SecurityCse = '{827D319E-6EAC-11D2-A4EA-00C04F79F83A}'
$SecurityPair = '[{827D319E-6EAC-11D2-A4EA-00C04F79F83A}{803E14A0-B4FB-11D0-A0D0-00A0C90F574B}]'
$Rdu = '*S-1-5-32-555'
$PrintOps = '*S-1-5-32-550'
$Shared = Join-Path $env:PUBLIC 'adslayer-proto'
New-Item -ItemType Directory -Force -Path $Shared | Out-Null

function Say([string]$status, [string]$name, [string]$detail) { "{0,-4} {1} -- {2}" -f $status, $name, $detail }
function Check([string]$name, [bool]$ok, [string]$detail) { Say $(if ($ok) { 'PASS' } else { 'FAIL' }) $name $detail }

function Get-Gpc($gpo) { Get-ADObject "CN={$($gpo.Id)},CN=Policies,CN=System,$dn" -Server $server -Properties versionNumber, gPCMachineExtensionNames }
function Get-Versions($gpo) {
    $g = Get-GPO -Guid $gpo.Id -Domain $domain -Server $server
    $gpc = Get-Gpc $gpo
    [ordered]@{ ad = [int]$gpc.versionNumber; ds = $g.Computer.DSVersion; sysvol = $g.Computer.SysvolVersion; cse = [string]$gpc.gPCMachineExtensionNames }
}
function Has-SecurityCse($v) { $v.cse -like "*$SecurityCse*" }

function New-Inf([string]$right, [string]$holders) {
    @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]', "$right = $holders") -join "`r`n"
}
# UTF-16 with a BOM, as Windows saves it.
function Write-Inf([string]$path, [string]$text) {
    New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
    [IO.File]::WriteAllText($path, $text, [Text.Encoding]::Unicode)
}

# Who holds a user right in this DC's local security database, where the security extension
# writes the rights it applies.
function Get-EffectiveRight([string]$right) {
    $out = Join-Path $env:TEMP "adslayer-proto-$([guid]::NewGuid().ToString('N').Substring(0,6)).inf"
    secedit.exe /export /areas USER_RIGHTS /cfg $out | Out-Null
    $line = Get-Content $out | Where-Object { $_ -match "^$right\s*=" } | Select-Object -First 1
    Remove-Item $out -ErrorAction SilentlyContinue
    if ($line) { ($line -split '=', 2)[1].Trim() } else { '' }
}
# Applied when, after gpupdate, the DC's local security database holds the SID for the right: the
# security extension writes the rights it applies there. The script resets the right before the
# experiments, so a SID found there was put there by this run. Also says whether the computer's
# Resultant Set of Policy (gpresult /x) lists the right at all.
function Test-Applied($gpo, [string]$right, [string]$sid) {
    gpupdate.exe /target:computer /force | Out-Null
    $xml = Join-Path $env:TEMP "adslayer-proto-rsop-$([guid]::NewGuid().ToString('N').Substring(0,6)).xml"
    gpresult.exe /scope computer /x $xml /f | Out-Null
    $text = [IO.File]::ReadAllText($xml)
    Remove-Item $xml -ErrorAction SilentlyContinue
    $block = [regex]::Matches($text, '<(\w+:)?UserRightsAssignment>.*?</(\w+:)?UserRightsAssignment>', 'Singleline') |
        ForEach-Object Value | Where-Object { $_ -match ">$right<" } | Select-Object -First 1
    $local = Get-EffectiveRight $right
    @{ Ok = ($local -split ',' | ForEach-Object { $_.Trim() }) -contains $sid; Rsop = $(if ($block) { 'right listed' } else { 'right not listed' }); Local = $local }
}
function Get-SysvolInf($gpo) {
    $p = "\\$domain\SYSVOL\$domain\Policies\{$($gpo.Id)}\Machine\Microsoft\Windows NT\SecEdit\GptTmpl.inf"
    if (Test-Path $p) { ([IO.File]::ReadAllText($p)) -match 'SeTimeZonePrivilege' } else { $false }
}

# Path A: back up, edit GptTmpl.inf inside the backup, import it. $between runs after the backup and
# before the import, to stand for someone else editing the GPO. With -Guard, the import is skipped
# when the GPO's version moved after the backup.
function Invoke-PathA($gpo, [string]$infText, [scriptblock]$between, [switch]$Guard, [switch]$AddCseToBackupXml) {
    $dir = Join-Path $Shared "a-$([guid]::NewGuid().ToString('N').Substring(0,6))"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $before = Get-Versions $gpo
    $backup = Backup-GPO -Guid $gpo.Id -Path $dir -Domain $domain -Server $server
    $root = Join-Path $dir "{$($backup.Id)}"
    Write-Inf (Join-Path $root 'DomainSysvol\GPO\Machine\microsoft\windows nt\SecEdit\GptTmpl.inf') $infText
    if ($AddCseToBackupXml) {
        $xml = Join-Path $root 'Backup.xml'
        $text = [IO.File]::ReadAllText($xml)
        $element = [regex]::Match($text, '<MachineExtensionGuids[^>]*/>|<MachineExtensionGuids>.*?</MachineExtensionGuids>', 'Singleline').Value
        Say 'INFO' 'A1b Backup.xml before the edit' $element
        $text = if ($element -match '/>$') { $text.Replace($element, "<MachineExtensionGuids><![CDATA[$SecurityPair]]></MachineExtensionGuids>") }
                elseif ($element) { $text.Replace($element, ($element -replace '<!\[CDATA\[', "<![CDATA[$SecurityPair")) }
                else { $text -replace '</GroupPolicyObject>', "<MachineExtensionGuids><![CDATA[$SecurityPair]]></MachineExtensionGuids></GroupPolicyObject>" }
        [IO.File]::WriteAllText($xml, $text, [Text.Encoding]::UTF8)
    }
    if ($between) { & $between }
    if ($Guard) {
        $now = Get-Versions $gpo
        if ($now.ad -ne $before.ad) { return @{ Imported = $false; Before = $before; Now = $now; Dir = $dir; BackupId = $backup.Id } }
    }
    Import-GPO -BackupId $backup.Id -Path $dir -TargetGuid $gpo.Id -Domain $domain -Server $server | Out-Null
    @{ Imported = $true; Before = $before; After = (Get-Versions $gpo); Dir = $dir; BackupId = $backup.Id }
}

# Path B: write GptTmpl.inf in SYSVOL, raise the computer half of the version in GPT.INI and in AD
# together, and add the security extension pair to gPCMachineExtensionNames, kept sorted.
function Invoke-PathB($gpo, [string]$infText) {
    $sysvol = "\\$domain\SYSVOL\$domain\Policies\{$($gpo.Id)}"
    Write-Inf "$sysvol\Machine\Microsoft\Windows NT\SecEdit\GptTmpl.inf" $infText
    $gpc = Get-Gpc $gpo
    $version = [int]$gpc.versionNumber + 1
    $ini = Get-Content "$sysvol\GPT.INI"
    $ini = if ($ini -match '^Version=') { $ini -replace '^Version=\d+', "Version=$version" } else { @($ini) + "Version=$version" }
    Set-Content "$sysvol\GPT.INI" $ini -Encoding Ascii
    $pairs = @([regex]::Matches([string]$gpc.gPCMachineExtensionNames, '\[[^\]]+\]') | ForEach-Object { $_.Value })
    if ($pairs -notcontains $SecurityPair) { $pairs += $SecurityPair }
    $cse = ($pairs | Sort-Object) -join ''
    Set-ADObject $gpc.DistinguishedName -Server $server -Replace @{ versionNumber = $version; gPCMachineExtensionNames = $cse }
}

# Sets a right in the DC's local security database directly, to undo what an earlier run left set.
function Restore-Right([string]$right, [string]$holders) {
    if ((Get-EffectiveRight $right) -eq $holders) { return }
    $cfg = Join-Path $env:TEMP 'adslayer-proto-restore.inf'
    $db = Join-Path $env:TEMP 'adslayer-proto-restore.sdb'
    Write-Inf $cfg (New-Inf $right $holders)
    secedit.exe /configure /db $db /cfg $cfg /areas USER_RIGHTS /quiet | Out-Null
    Remove-Item $cfg, $db -ErrorAction SilentlyContinue
}

function Remove-ProtoGpo([string]$name) {
    $g = Get-GPO -Name $name -Domain $domain -Server $server -ErrorAction SilentlyContinue
    if (-not $g) { return }
    Remove-GPLink -Guid $g.Id -Target $dcOu -Domain $domain -Server $server -ErrorAction SilentlyContinue | Out-Null
    Remove-GPO -Guid $g.Id -Domain $domain -Server $server
}

if ($Mode -eq 'da') {
    # Leave out the two SIDs this script adds, in case an earlier run left them set.
    $holders = (Get-EffectiveRight 'SeTimeZonePrivilege') -split ',' | Where-Object { $_ -and $_ -notin $Rdu, $PrintOps }
    $holders = $holders -join ','
    Restore-Right 'SeTimeZonePrivilege' $holders
    Say 'INFO' 'SeTimeZonePrivilege on dc01 before' (Get-EffectiveRight 'SeTimeZonePrivilege')
    $plusRdu = (@($holders -split ',' | Where-Object { $_ }) + $Rdu | Select-Object -Unique) -join ','
    $plusBoth = (@($plusRdu -split ',') + $PrintOps | Select-Object -Unique) -join ','
    try {
        # A1: a GPO with no security settings.
        $a = New-GPO -Name 'adslayer-proto-A' -Domain $domain -Server $server
        $r = Invoke-PathA $a (New-Inf 'SeTimeZonePrivilege' $plusRdu)
        Check 'A1 Import-GPO raises the version of a GPO that had no security settings' ($r.After.ad -gt $r.Before.ad) "ad $($r.Before.ad) -> $($r.After.ad); ds $($r.After.ds) sysvol $($r.After.sysvol)"
        Check 'A1 Import-GPO registers the security extension' (Has-SecurityCse $r.After) "gPCMachineExtensionNames: '$($r.After.cse)'"
        Check 'A1 Import-GPO copies the edited GptTmpl.inf into SYSVOL' (Get-SysvolInf $a) ''
        if (-not (Has-SecurityCse $r.After)) {
            $a1b = New-GPO -Name 'adslayer-proto-A1b' -Domain $domain -Server $server
            $rb = Invoke-PathA $a1b (New-Inf 'SeTimeZonePrivilege' $plusRdu) -AddCseToBackupXml
            Check 'A1b with the extension added to Backup.xml, Import-GPO registers it' (Has-SecurityCse $rb.After) "gPCMachineExtensionNames: '$($rb.After.cse)'"
            Check 'A1b and copies GptTmpl.inf into SYSVOL' (Get-SysvolInf $a1b) ''
            # A1b is the one that may work end to end, so A2 and A3 use it when it registered the extension.
            if (Has-SecurityCse $rb.After) { Remove-ProtoGpo 'adslayer-proto-A'; $a = $a1b }
        }

        # A2: does it apply?
        New-GPLink -Guid $a.Id -Target $dcOu -LinkEnabled Yes -Order 1 -Domain $domain -Server $server | Out-Null
        $t = Test-Applied $a 'SeTimeZonePrivilege' $Rdu
        Check 'A2 the right applies on dc01 after gpupdate' $t.Ok "RSoP: $($t.Rsop); local database: $($t.Local)"
        $report = Get-GPOReport -Guid $a.Id -ReportType Xml -Domain $domain -Server $server
        Check 'A2 GPMC report shows the right' ($report -match 'SeTimeZonePrivilege') ''

        # A3: a GPO that already has security settings.
        $r = Invoke-PathA $a (New-Inf 'SeTimeZonePrivilege' $plusBoth) -AddCseToBackupXml:($a.DisplayName -eq 'adslayer-proto-A1b')
        $t = Test-Applied $a 'SeTimeZonePrivilege' $PrintOps
        Check 'A3 a second import raises the version again and applies' ($r.After.ad -gt $r.Before.ad -and $t.Ok) "ad $($r.Before.ad) -> $($r.After.ad); RSoP: $($t.Rsop); local database: $($t.Local)"

        # A4: someone else edits the GPO between the backup and the import.
        $between = { Set-GPRegistryValue -Guid $a.Id -Key 'HKLM\Software\Policies\adslayer-proto' -ValueName 'Between' -Type DWord -Value 1 -Domain $domain -Server $server | Out-Null }
        $r = Invoke-PathA $a (New-Inf 'SeTimeZonePrivilege' $plusRdu) $between
        $kept = $null -ne (Get-GPRegistryValue -Guid $a.Id -Key 'HKLM\Software\Policies\adslayer-proto' -ValueName 'Between' -Domain $domain -Server $server -ErrorAction SilentlyContinue)
        Say $(if ($kept) { 'INFO' } else { 'WARN' }) 'A4 without a guard, an edit made between backup and import is' $(if ($kept) { 'kept' } else { 'lost: the import replaced it' })
        $between2 = { Set-GPRegistryValue -Guid $a.Id -Key 'HKLM\Software\Policies\adslayer-proto' -ValueName 'Between2' -Type DWord -Value 1 -Domain $domain -Server $server | Out-Null }
        $r = Invoke-PathA $a (New-Inf 'SeTimeZonePrivilege' $plusRdu) $between2 -Guard
        Check 'A4 a version check before the import catches the edit and skips the import' (-not $r.Imported) "ad $($r.Before.ad) at backup, $($r.Now.ad) before import"

        # B1: direct edit with guardrails, on a fresh GPO.
        $b = New-GPO -Name 'adslayer-proto-B' -Domain $domain -Server $server
        Invoke-PathB $b (New-Inf 'SeTimeZonePrivilege' $plusRdu)
        $v = Get-Versions $b
        Check 'B1 AD and SYSVOL versions agree, and the security extension is registered' ($v.ds -eq $v.sysvol -and $v.ds -gt 0 -and (Has-SecurityCse $v)) "ds $($v.ds) sysvol $($v.sysvol); '$($v.cse)'"
        Remove-GPLink -Guid $a.Id -Target $dcOu -Domain $domain -Server $server | Out-Null
        New-GPLink -Guid $b.Id -Target $dcOu -LinkEnabled Yes -Order 1 -Domain $domain -Server $server | Out-Null
        $t = Test-Applied $b 'SeTimeZonePrivilege' $Rdu
        Check 'B1 the right applies on dc01 after gpupdate' $t.Ok "RSoP: $($t.Rsop); local database: $($t.Local)"
        $report = Get-GPOReport -Guid $b.Id -ReportType Xml -Domain $domain -Server $server
        Check 'B1 GPMC report shows the right' ($report -match 'SeTimeZonePrivilege') ''

        # A6: path A on a GPO whose backup already carries a GptTmpl.inf (B, after B1).
        $r = Invoke-PathA $b (New-Inf 'SeTimeZonePrivilege' $plusBoth)
        $inf = "\\$domain\SYSVOL\$domain\Policies\{$($b.Id)}\Machine\Microsoft\Windows NT\SecEdit\GptTmpl.inf"
        $copied = (Test-Path $inf) -and ([IO.File]::ReadAllText($inf) -match [regex]::Escape($PrintOps))
        $t = Test-Applied $b 'SeTimeZonePrivilege' $PrintOps
        Check 'A6 on a GPO that already has a GptTmpl.inf, Import-GPO copies the edit and it applies' ($copied -and $t.Ok) "copied: $copied; ad $($r.Before.ad) -> $($r.After.ad); RSoP: $($t.Rsop); local database: $($t.Local)"
    } finally {
        foreach ($n in 'adslayer-proto-A', 'adslayer-proto-A1b', 'adslayer-proto-B') { Remove-ProtoGpo $n }
        gpupdate.exe /target:computer /force | Out-Null
        # A user right from a deleted GPO stays set ("tattooed") until another policy sets it. Put
        # the DC's local value back as it was before the experiments.
        $tattooed = Get-EffectiveRight 'SeTimeZonePrivilege'
        Say 'INFO' 'SeTimeZonePrivilege on dc01 after the GPOs were deleted' $tattooed
        Restore-Right 'SeTimeZonePrivilege' $holders
        $now = Get-EffectiveRight 'SeTimeZonePrivilege'
        Check 'cleanup: SeTimeZonePrivilege on dc01 is back to what it was' ($now -eq $holders) $now
    }
}

if ($Mode -eq 'delegated') {
    $lb = Get-GPO -Name 'Lab Baseline' -Domain $domain -Server $server
    $restore = Join-Path $Shared 'lab-baseline-before'
    if (Test-Path $restore) { Remove-Item $restore -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $restore | Out-Null
    $before = Backup-GPO -Guid $lb.Id -Path $restore -Domain $domain -Server $server
    Say 'INFO' 'Lab Baseline before' ((Get-Versions $lb) | ConvertTo-Json -Compress)
    try {
        try {
            $r = Invoke-PathA $lb (New-Inf 'SeTimeZonePrivilege' $Rdu)
            Check 'A5 lab.delegated has the rights to back up and import Lab Baseline (whether the template arrives is A1)' ($r.After.ad -gt $r.Before.ad) "ad $($r.Before.ad) -> $($r.After.ad); '$($r.After.cse)'"
        } catch { Check 'A5 lab.delegated has the rights to back up and import Lab Baseline (whether the template arrives is A1)' $false $_.Exception.Message }
        try {
            Invoke-PathB $lb (New-Inf 'SeTimeZonePrivilege' "$Rdu,$PrintOps")
            $v = Get-Versions $lb
            Check 'B2 lab.delegated can write GptTmpl.inf, GPT.INI and versionNumber on Lab Baseline' ($v.ds -eq $v.sysvol) "ds $($v.ds) sysvol $($v.sysvol)"
        } catch { Check 'B2 lab.delegated can write GptTmpl.inf, GPT.INI and versionNumber on Lab Baseline' $false $_.Exception.Message }
    } finally {
        # The backup taken first is the before-state: importing it puts Lab Baseline back.
        try {
            Import-GPO -BackupId $before.Id -Path $restore -TargetGuid $lb.Id -Domain $domain -Server $server | Out-Null
            Say 'INFO' 'Lab Baseline restored from its backup by lab.delegated' ((Get-Versions $lb) | ConvertTo-Json -Compress)
        } catch { Say 'WARN' 'lab.delegated could not restore Lab Baseline; check mode will' $_.Exception.Message }
    }
}

if ($Mode -eq 'check') {
    $left = @(Get-GPO -All -Domain $domain -Server $server | Where-Object { $_.DisplayName -like 'adslayer-proto-*' })
    Check 'cleanup: no adslayer-proto-* GPO is left' ($left.Count -eq 0) (($left | ForEach-Object DisplayName) -join ', ')
    $lb = Get-GPO -Name 'Lab Baseline' -Domain $domain -Server $server
    $inf = "\\$domain\SYSVOL\$domain\Policies\{$($lb.Id)}\Machine\Microsoft\Windows NT\SecEdit\GptTmpl.inf"
    if (Test-Path $inf) {
        $restore = Join-Path $Shared 'lab-baseline-before'
        $id = (Get-ChildItem $restore -Directory | Select-Object -First 1).Name.Trim('{}')
        Import-GPO -BackupId $id -Path $restore -TargetGuid $lb.Id -Domain $domain -Server $server | Out-Null
        Say 'INFO' 'check mode restored Lab Baseline from the backup' ''
    }
    $lock = Get-GPRegistryValue -Name 'Lab Baseline' -Key 'HKLM\Software\Policies\Microsoft\Windows\Personalization' -ValueName 'NoLockScreen' -Domain $domain -Server $server -ErrorAction SilentlyContinue
    Check 'cleanup: Lab Baseline has no security template and still sets NoLockScreen = 1' ((-not (Test-Path $inf)) -and $lock.Value -eq 1) ((Get-Versions $lb) | ConvertTo-Json -Compress)
    Remove-Item $Shared -Recurse -Force -ErrorAction SilentlyContinue
}
