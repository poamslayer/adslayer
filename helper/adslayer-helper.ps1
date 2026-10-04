# adslayer LDAP helper. ADR-0003.
#
# Speaks JSON lines: one request per line on stdin, { "id", "op", "args" }, and one answer per
# line on stdout, { "id", "ok": true, "value" } or { "id", "ok": false, "error": { "code", "message" } }.
# Stdout is the protocol and nothing else may write to it. Diagnostics go to stderr.
#
# Every LDAP call runs as the logged-on user: Negotiate (Kerberos) with signing and sealing, and no
# credential anywhere (ADR-0002). Each domain gets one connection, kept open, to its PDC emulator
# (ADR-0006). Runs on PowerShell 7 and on Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.DirectoryServices.Protocols

$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$stdout = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8
$stdout.AutoFlush = $true
$stdin = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8

# Type-name prefix. Not $P: PowerShell names are case-insensitive, so any $p would overwrite it.
$Sdp = 'System.DirectoryServices.Protocols'
$PageSize = 500
$DefaultMax = 1000
$HardMax = 20000
$strictUtf8 = New-Object System.Text.UTF8Encoding $false, $true

# domain (lowercase) -> @{ Connection; Pdc; DefaultNamingContext }
$script:connections = @{}

class HelperError : System.Exception {
    [string]$Code
    HelperError([string]$code, [string]$message) : base($message) { $this.Code = $code }
}

function Write-Answer($answer) {
    $stdout.WriteLine(($answer | ConvertTo-Json -Depth 32 -Compress))
}

# The logged-on user. WindowsIdentity exists only on Windows; the fallback lets the protocol
# layer run elsewhere for tests, where no LDAP call will work anyway.
function Get-LogonUser {
    try { [System.Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { [Environment]::UserName }
}

function Write-Log([string]$message) {
    [Console]::Error.WriteLine("adslayer-helper: $message")
}

# --- Connections ----------------------------------------------------------------------------

# Built from properties, not New-Object arguments: New-Object folds a string[] argument into one
# space-joined string, which asks AD for a single attribute that does not exist.
function New-SearchRequest([string]$dn, [string]$filter, [System.DirectoryServices.Protocols.SearchScope]$scope, [string[]]$attributes) {
    $req = New-Object "$Sdp.SearchRequest"
    $req.DistinguishedName = $dn
    $req.Filter = $filter
    $req.Scope = $scope
    foreach ($name in $attributes) { [void]$req.Attributes.Add($name) }
    $req
}

function New-SealedConnection([string]$server) {
    $c = New-Object "$Sdp.LdapConnection" (New-Object "$Sdp.LdapDirectoryIdentifier" $server, 389)
    $c.AuthType = [System.DirectoryServices.Protocols.AuthType]::Negotiate
    $c.SessionOptions.ProtocolVersion = 3
    $c.SessionOptions.Signing = $true
    $c.SessionOptions.Sealing = $true
    # Referrals would send a call to a DC other than the PDC emulator.
    $c.SessionOptions.ReferralChasing = [System.DirectoryServices.Protocols.ReferralChasingOptions]::None
    $c.Timeout = [TimeSpan]::FromMinutes(2)
    $c.Bind()   # no credential: the logged-on user
    $c
}

function Get-RootDse($connection) {
    $req = New-SearchRequest '' '(objectClass=*)' ([System.DirectoryServices.Protocols.SearchScope]::Base) @('defaultNamingContext', 'dnsHostName')
    $e = $connection.SendRequest($req).Entries[0]
    @{ DefaultNamingContext = [string]$e.Attributes['defaultNamingContext'][0]; DnsHostName = [string]$e.Attributes['dnsHostName'][0] }
}

# Finds the PDC emulator through any DC of the domain: fSMORoleOwner on the domain head names the
# PDC's NTDS Settings object, whose parent is the server object holding dNSHostName.
function Find-Pdc([string]$domain) {
    $any = New-SealedConnection $domain
    try {
        $root = Get-RootDse $any
        $req = New-SearchRequest $root.DefaultNamingContext '(objectClass=*)' ([System.DirectoryServices.Protocols.SearchScope]::Base) @('fSMORoleOwner')
        $ntds = [string]$any.SendRequest($req).Entries[0].Attributes['fSMORoleOwner'][0]
        $serverDn = $ntds.Substring($ntds.IndexOf(',') + 1)
        $req = New-SearchRequest $serverDn '(objectClass=*)' ([System.DirectoryServices.Protocols.SearchScope]::Base) @('dNSHostName')
        [string]$any.SendRequest($req).Entries[0].Attributes['dNSHostName'][0]
    } finally { $any.Dispose() }
}

function Get-Connection([string]$domain) {
    if ([string]::IsNullOrWhiteSpace($domain)) { throw [HelperError]::new('BadRequest', 'domain is required') }
    $key = $domain.ToLowerInvariant()
    if (-not $script:connections.ContainsKey($key)) {
        $pdc = Find-Pdc $domain
        $c = New-SealedConnection $pdc
        $root = Get-RootDse $c
        $script:connections[$key] = @{ Connection = $c; Pdc = $pdc; DefaultNamingContext = $root.DefaultNamingContext }
        Write-Log "connected to $domain through PDC emulator $pdc"
    }
    $script:connections[$key]
}

function Reset-Connection([string]$domain) {
    $key = $domain.ToLowerInvariant()
    if ($script:connections.ContainsKey($key)) {
        try { $script:connections[$key].Connection.Dispose() } catch { }
        $script:connections.Remove($key)
    }
}

# Runs a request; if the connection went away (the DC restarted, the session timed out), opens a
# new one and tries once more.
function Send-Request([string]$domain, $request) {
    try {
        return (Get-Connection $domain).Connection.SendRequest($request)
    } catch {
        $ex = Get-InnerException $_.Exception
        # 81 server down, 82 local error, 91 connect error. Anything else is the DC's answer.
        if (-not ($ex -is [System.DirectoryServices.Protocols.LdapException] -and $ex.ErrorCode -in 81, 82, 91)) { throw }
        Write-Log "connection to $domain lost ($($ex.Message)); reconnecting"
        Reset-Connection $domain
        return (Get-Connection $domain).Connection.SendRequest($request)
    }
}

# PowerShell wraps exceptions from .NET method calls; the LDAP exception is inside.
function Get-InnerException($ex) {
    while (($ex -is [System.Management.Automation.MethodInvocationException] -or
            $ex -is [System.Management.Automation.RuntimeException] -and $ex -isnot [HelperError]) -and $ex.InnerException) {
        $ex = $ex.InnerException
    }
    $ex
}

# --- Values ---------------------------------------------------------------------------------

function ConvertTo-JsonValue([string]$attribute, [byte[]]$bytes) {
    $name = $attribute.ToLowerInvariant()
    if ($bytes.Length -eq 16 -and $name.EndsWith('guid')) { return ([guid]::new($bytes)).ToString() }
    if ($name -eq 'objectsid' -or $name -eq 'sidhistory' -or $name.EndsWith('securityidentifier')) {
        return (New-Object System.Security.Principal.SecurityIdentifier $bytes, 0).Value
    }
    try {
        $text = $strictUtf8.GetString($bytes)
        if ($text -notmatch '[\x00-\x08\x0B\x0C\x0E-\x1F]') { return $text }
    } catch { }
    @{ base64 = [Convert]::ToBase64String($bytes) }
}

function ConvertFrom-JsonValue($value) {
    if ($null -eq $value) { throw [HelperError]::new('BadRequest', 'attribute values cannot be null') }
    if ($value -is [string]) { return $value }
    # The comma keeps the byte[] whole; a bare return would unroll it into object[].
    if ($value.PSObject.Properties['base64']) { return , [Convert]::FromBase64String([string]$value.base64) }
    if ($value -is [bool] -or $value -is [int] -or $value -is [long] -or $value -is [double]) {
        # LDAP has no number or boolean type. AD spells booleans TRUE and FALSE.
        if ($value -is [bool]) { return $(if ($value) { 'TRUE' } else { 'FALSE' }) }
        return [string]$value
    }
    throw [HelperError]::new('BadRequest', 'an attribute value must be a string, a number, a boolean, or { base64 }')
}

# A foreach and a List, not a pipeline: a pipeline would unroll a byte[] value into its bytes.
function ConvertFrom-JsonValues($values) {
    $out = New-Object System.Collections.Generic.List[object]
    if ($values -is [System.Array]) { foreach ($v in $values) { $out.Add((ConvertFrom-JsonValue $v)) } }
    else { $out.Add((ConvertFrom-JsonValue $values)) }
    , $out.ToArray()
}

function New-DirectoryAttribute([string]$name, $values) {
    $converted = ConvertFrom-JsonValues $values
    $attr = New-Object "$Sdp.DirectoryAttribute"
    $attr.Name = $name
    foreach ($v in $converted) { if ($v -is [byte[]]) { [void]$attr.Add([byte[]]$v) } else { [void]$attr.Add([string]$v) } }
    # The comma stops PowerShell unrolling the collection into its values on the way out.
    , $attr
}

# --- Controls -------------------------------------------------------------------------------

# The controls a script may send, by name. The binding checks the names first; this is the second
# check. showDeleted shows objects in the Recycle Bin and allows a modify that restores one.
function Add-Controls($request, $controls) {
    if ($null -eq $controls) { return }
    foreach ($p in $controls.PSObject.Properties) {
        if ($p.Value -ne $true) { throw [HelperError]::new('BadRequest', "control $($p.Name) must be true") }
        switch ($p.Name) {
            'showDeleted' { [void]$request.Controls.Add((New-Object "$Sdp.ShowDeletedControl")) }
            default { throw [HelperError]::new('BadRequest', "unknown control '$($p.Name)'") }
        }
    }
}

# --- Search ---------------------------------------------------------------------------------

function Read-Attribute($attr) {
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($bytes in $attr.GetValues([byte[]])) { $out.Add((ConvertTo-JsonValue $attr.Name ([byte[]]$bytes))) }
    , $out.ToArray()
}

# Large multi-valued attributes come back in slices named like "member;range=0-1499". Fetch the
# rest of the slices and return the whole list under the plain name.
#
# An answer can carry both "member;range=0-1499" and an empty plain "member" (seen for a delegated
# user on PowerShell 7). The plain one must not overwrite the ranged values, so it is skipped.
function Read-Entry([string]$domain, $entry, $controls = $null) {
    $out = [ordered]@{}
    $names = @($entry.Attributes.AttributeNames)
    $ranged = @{}
    foreach ($name in $names) { if ($name -match '^([^;]+);range=') { $ranged[$Matches[1].ToLowerInvariant()] = $true } }
    foreach ($name in $names) {
        if ($name -notmatch ';' -and $ranged.ContainsKey($name.ToLowerInvariant())) { continue }
        $attr = $entry.Attributes[$name]
        if ($name -match '^(?<base>[^;]+);range=(?<lo>\d+)-(?<hi>\d+|\*)$') {
            $base = $Matches['base']
            $values = New-Object System.Collections.Generic.List[object]
            $hi = $Matches['hi']
            $values.AddRange([object[]](Read-Attribute $attr))
            while ($hi -ne '*') {
                $next = [int]$hi + 1
                $req = New-SearchRequest $entry.DistinguishedName '(objectClass=*)' ([System.DirectoryServices.Protocols.SearchScope]::Base) @("$base;range=$next-*")
                # A deleted object is found again only with the same controls.
                Add-Controls $req $controls
                $slice = (Send-Request $domain $req).Entries[0]
                $sliceName = @($slice.Attributes.AttributeNames) | Where-Object { $_ -like "$base;range=*" } | Select-Object -First 1
                if (-not $sliceName) { break }
                $values.AddRange([object[]](Read-Attribute $slice.Attributes[$sliceName]))
                $hi = ($sliceName -split '-')[-1]
            }
            $out[$base] = $values.ToArray()
        } else {
            $out[$attr.Name] = Read-Attribute $attr
        }
    }
    [ordered]@{ dn = $entry.DistinguishedName; attributes = $out }
}

function Invoke-Search($a) {
    $domain = [string]$a.domain
    $conn = Get-Connection $domain
    $base = if ($a.base) { [string]$a.base } else { $conn.DefaultNamingContext }
    $filter = if ($a.filter) { [string]$a.filter } else { '(objectClass=*)' }
    $scope = switch ([string]$a.scope) {
        'base' { [System.DirectoryServices.Protocols.SearchScope]::Base }
        'one' { [System.DirectoryServices.Protocols.SearchScope]::OneLevel }
        { $_ -in '', 'sub', 'subtree' } { [System.DirectoryServices.Protocols.SearchScope]::Subtree }
        default { throw [HelperError]::new('BadRequest', "scope must be base, one or sub, not '$_'") }
    }
    $attributes = if ($a.attributes) { [string[]]@($a.attributes) } else { [string[]]@('distinguishedName') }
    $max = if ($a.max) { [Math]::Min([int]$a.max, $HardMax) } else { $DefaultMax }

    $req = New-SearchRequest $base $filter $scope $attributes
    Add-Controls $req $a.controls
    $page = New-Object "$Sdp.PageResultRequestControl" ([Math]::Min($PageSize, $max))
    [void]$req.Controls.Add($page)

    $entries = New-Object System.Collections.Generic.List[object]
    $more = $false
    while ($true) {
        $resp = Send-Request $domain $req
        foreach ($e in $resp.Entries) {
            if ($entries.Count -ge $max) { $more = $true; break }
            $entries.Add((Read-Entry $domain $e $a.controls))
        }
        if ($more) { break }
        $cookie = ($resp.Controls | Where-Object { $_ -is [System.DirectoryServices.Protocols.PageResultResponseControl] } | Select-Object -First 1).Cookie
        if (-not $cookie -or $cookie.Length -eq 0) { break }
        # Full, and the server still has pages: say so rather than fetch them.
        if ($entries.Count -ge $max) { $more = $true; break }
        $page.Cookie = $cookie
    }
    [ordered]@{ entries = $entries.ToArray(); more = $more }
}

# --- Writes ---------------------------------------------------------------------------------

function Invoke-Add($a) {
    if (-not $a.dn) { throw [HelperError]::new('BadRequest', 'add needs dn') }
    if (-not $a.attributes) { throw [HelperError]::new('BadRequest', 'add needs attributes, including objectClass') }
    $req = New-Object "$Sdp.AddRequest"
    $req.DistinguishedName = [string]$a.dn
    foreach ($p in $a.attributes.PSObject.Properties) { [void]$req.Attributes.Add((New-DirectoryAttribute $p.Name $p.Value)) }
    [void](Send-Request ([string]$a.domain) $req)
    [ordered]@{ dn = [string]$a.dn }
}

function Invoke-Modify($a) {
    if (-not $a.dn) { throw [HelperError]::new('BadRequest', 'modify needs dn') }
    $changes = @($a.changes)
    if ($changes.Count -eq 0) { throw [HelperError]::new('BadRequest', 'modify needs at least one change') }
    $req = New-Object "$Sdp.ModifyRequest"
    $req.DistinguishedName = [string]$a.dn
    foreach ($ch in $changes) {
        $m = New-Object "$Sdp.DirectoryAttributeModification"
        $m.Name = [string]$ch.attribute
        $m.Operation = switch ([string]$ch.op) {
            'add' { [System.DirectoryServices.Protocols.DirectoryAttributeOperation]::Add }
            'replace' { [System.DirectoryServices.Protocols.DirectoryAttributeOperation]::Replace }
            'delete' { [System.DirectoryServices.Protocols.DirectoryAttributeOperation]::Delete }
            default { throw [HelperError]::new('BadRequest', "change op must be add, replace or delete, not '$_'") }
        }
        if ($null -ne $ch.values) {
            foreach ($v in (ConvertFrom-JsonValues $ch.values)) { if ($v -is [byte[]]) { [void]$m.Add([byte[]]$v) } else { [void]$m.Add([string]$v) } }
        }
        [void]$req.Modifications.Add($m)
    }
    Add-Controls $req $a.controls
    [void](Send-Request ([string]$a.domain) $req)
    # A restore from the Recycle Bin moves the object by replacing distinguishedName, so answer
    # with where it is now, not where it was.
    $moved = @($changes | Where-Object { [string]$_.op -eq 'replace' -and ([string]$_.attribute) -eq 'distinguishedName' } | Select-Object -Last 1)
    $dn = if ($moved.Count -gt 0) { [string]@($moved[0].values)[0] } else { [string]$a.dn }
    [ordered]@{ dn = $dn }
}

function Invoke-Delete($a) {
    if (-not $a.dn) { throw [HelperError]::new('BadRequest', 'delete needs dn') }
    $req = New-Object "$Sdp.DeleteRequest" ([string]$a.dn)
    if ($a.tree) { [void]$req.Controls.Add((New-Object "$Sdp.TreeDeleteControl")) }
    [void](Send-Request ([string]$a.domain) $req)
    [ordered]@{ dn = [string]$a.dn }
}

# The first RDN of a DN, honouring escaped commas.
function Get-Rdn([string]$dn) {
    for ($i = 0; $i -lt $dn.Length; $i++) {
        if ($dn[$i] -eq '\') { $i++; continue }
        if ($dn[$i] -eq ',') { return @{ Rdn = $dn.Substring(0, $i); Parent = $dn.Substring($i + 1) } }
    }
    @{ Rdn = $dn; Parent = '' }
}

function Invoke-Move($a) {
    if (-not $a.dn) { throw [HelperError]::new('BadRequest', 'move needs dn') }
    if (-not $a.newParent -and -not $a.newName) { throw [HelperError]::new('BadRequest', 'move needs newParent, newName, or both') }
    $parts = Get-Rdn ([string]$a.dn)
    $newName = if ($a.newName) { [string]$a.newName } else { $parts.Rdn }
    $newParent = if ($a.newParent) { [string]$a.newParent } else { $parts.Parent }
    $req = New-Object "$Sdp.ModifyDNRequest" ([string]$a.dn), $newParent, $newName
    [void](Send-Request ([string]$a.domain) $req)
    [ordered]@{ dn = "$newName,$newParent" }
}

# --- ACLs -----------------------------------------------------------------------------------
#
# The helper works in SIDs, access masks, ACE flags and GUIDs. The binding (src/core/sandbox/acl.ts)
# turns those into rights, inheritance and attribute, class and right names. .NET's ACL classes
# run only on Windows.

$AceTypePresent = [System.Security.AccessControl.ObjectAceFlags]::ObjectAceTypePresent
$InheritedAceTypePresent = [System.Security.AccessControl.ObjectAceFlags]::InheritedObjectAceTypePresent

function Get-SidName($sid) {
    try { $sid.Translate([System.Security.Principal.NTAccount]).Value } catch { $null }
}

# A SID as it is, or an account name such as CONTOSO\Helpdesk, translated by the domain.
function Resolve-Principal([string]$principal) {
    if ($principal -match '^S-1-') { return [System.Security.Principal.SecurityIdentifier]::new($principal) }
    try { ([System.Security.Principal.NTAccount]::new($principal)).Translate([System.Security.Principal.SecurityIdentifier]) }
    catch { throw [HelperError]::new('NoSuchPrincipal', "no account named '$principal'") }
}

# Every ACE in a descriptor's DACL, as { type, sid, name, mask, flags, objectType, inheritedObjectType }.
function ConvertTo-RawAces($sd) {
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($ace in $sd.DiscretionaryAcl) {
        $type = switch ([string]$ace.AceQualifier) { 'AccessAllowed' { 'allow' } 'AccessDenied' { 'deny' } default { [string]$_ } }
        $objectType = $null
        $inheritedObjectType = $null
        if ($ace -is [System.Security.AccessControl.ObjectAce]) {
            if ($ace.ObjectAceFlags -band $AceTypePresent) { $objectType = $ace.ObjectAceType.ToString() }
            if ($ace.ObjectAceFlags -band $InheritedAceTypePresent) { $inheritedObjectType = $ace.InheritedObjectAceType.ToString() }
        }
        # .NET holds the mask as a signed 32-bit number; JSON gets it unsigned.
        $mask = [long]$ace.AccessMask
        if ($mask -lt 0) { $mask += 4294967296 }
        $out.Add([ordered]@{
            type = $type; sid = $ace.SecurityIdentifier.Value; name = Get-SidName $ace.SecurityIdentifier
            mask = $mask
            flags = [int]$ace.AceFlags; objectType = $objectType; inheritedObjectType = $inheritedObjectType
        })
    }
    , $out.ToArray()
}

# The arguments AddAccess and RemoveAccessSpecific take, from one ACE as the binding sends it.
function Get-AceArgs($ace) {
    $flags = [System.Security.AccessControl.ObjectAceFlags]::None
    $objectType = [guid]::Empty
    $inheritedObjectType = [guid]::Empty
    if ($ace.objectType) { $flags = $flags -bor $AceTypePresent; $objectType = [guid][string]$ace.objectType }
    if ($ace.inheritedObjectType) { $flags = $flags -bor $InheritedAceTypePresent; $inheritedObjectType = [guid][string]$ace.inheritedObjectType }
    $type = switch ([string]$ace.type) {
        'allow' { [System.Security.AccessControl.AccessControlType]::Allow }
        'deny' { [System.Security.AccessControl.AccessControlType]::Deny }
        default { throw [HelperError]::new('BadRequest', "ace type must be allow or deny, not '$_'") }
    }
    $mask = [long]$ace.mask
    if ($mask -gt [int]::MaxValue) { $mask -= 4294967296 }
    @{
        Type = $type; Sid = Resolve-Principal ([string]$ace.principal); Mask = [int]$mask
        Inheritance = [System.Security.AccessControl.InheritanceFlags][int]$ace.inheritanceFlags
        Propagation = [System.Security.AccessControl.PropagationFlags][int]$ace.propagationFlags
        Flags = $flags; ObjectType = $objectType; InheritedObjectType = $inheritedObjectType
    }
}

function Add-Ace($sd, $ace) {
    $x = Get-AceArgs $ace
    $sd.DiscretionaryAcl.AddAccess($x.Type, $x.Sid, $x.Mask, $x.Inheritance, $x.Propagation, $x.Flags, $x.ObjectType, $x.InheritedObjectType)
}

# True when an ACE matching exactly was there and is now gone.
function Remove-Ace($sd, $ace) {
    $x = Get-AceArgs $ace
    $before = $sd.DiscretionaryAcl.Count
    $sd.DiscretionaryAcl.RemoveAccessSpecific($x.Type, $x.Sid, $x.Mask, $x.Inheritance, $x.Propagation, $x.Flags, $x.ObjectType, $x.InheritedObjectType)
    $sd.DiscretionaryAcl.Count -lt $before
}

# The SD_FLAGS control asks only for the parts named, so a user without rights to the SACL, or
# who does not own the object, can still read the owner and DACL and write the DACL.
function Read-SecurityDescriptor([string]$domain, [string]$dn, $masks) {
    $req = New-SearchRequest $dn '(objectClass=*)' ([System.DirectoryServices.Protocols.SearchScope]::Base) @('nTSecurityDescriptor')
    [void]$req.Controls.Add((New-Object "$Sdp.SecurityDescriptorFlagControl" $masks))
    $entry = (Send-Request $domain $req).Entries[0]
    # Assigned inside the if, not from it: an if's output would unroll the attribute into its bytes.
    $attr = $null
    if ($entry) { $attr = $entry.Attributes['nTSecurityDescriptor'] }
    if ($null -eq $attr) { throw [HelperError]::new('InsufficientAccessRights', "cannot read the security descriptor of $dn") }
    [System.Security.AccessControl.CommonSecurityDescriptor]::new($true, $true, [byte[]]$attr.GetValues([byte[]])[0], 0)
}

function Write-Dacl([string]$domain, [string]$dn, $sd) {
    $bytes = New-Object byte[] $sd.BinaryLength
    $sd.GetBinaryForm($bytes, 0)
    $m = New-Object "$Sdp.DirectoryAttributeModification"
    $m.Name = 'nTSecurityDescriptor'
    $m.Operation = [System.DirectoryServices.Protocols.DirectoryAttributeOperation]::Replace
    [void]$m.Add([byte[]]$bytes)
    $req = New-Object "$Sdp.ModifyRequest"
    $req.DistinguishedName = $dn
    [void]$req.Modifications.Add($m)
    [void]$req.Controls.Add((New-Object "$Sdp.SecurityDescriptorFlagControl" ([System.DirectoryServices.Protocols.SecurityMasks]::Dacl)))
    [void](Send-Request $domain $req)
}

function Invoke-AclGet($a) {
    if (-not $a.dn) { throw [HelperError]::new('BadRequest', 'acl.get needs dn') }
    $masks = [System.DirectoryServices.Protocols.SecurityMasks]::Owner -bor [System.DirectoryServices.Protocols.SecurityMasks]::Dacl
    $sd = Read-SecurityDescriptor ([string]$a.domain) ([string]$a.dn) $masks
    $protected = ($sd.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0
    [ordered]@{
        owner = [ordered]@{ sid = $sd.Owner.Value; name = Get-SidName $sd.Owner }
        protected = $protected
        aces = ConvertTo-RawAces $sd
    }
}

function Invoke-AclChange($a, [bool]$add) {
    if (-not $a.dn -or -not $a.ace) { throw [HelperError]::new('BadRequest', 'acl.add and acl.remove need dn and ace') }
    $domain = [string]$a.domain
    $dn = [string]$a.dn
    $sd = Read-SecurityDescriptor $domain $dn ([System.DirectoryServices.Protocols.SecurityMasks]::Dacl)
    if ($add) {
        Add-Ace $sd $a.ace
        Write-Dacl $domain $dn $sd
        return [ordered]@{ dn = $dn }
    }
    $removed = Remove-Ace $sd $a.ace
    if ($removed) { Write-Dacl $domain $dn $sd }
    [ordered]@{ dn = $dn; removed = $removed }
}

# --- Group Policy (ADR-0007) ----------------------------------------------------------------
#
# GPO changes go through Microsoft's GroupPolicy module, which keeps the GPO's version numbers and
# extension GUIDs right. Every cmdlet gets -Server, the PDC emulator, as LDAP calls do (ADR-0006).

$script:gpModuleLoaded = $false
function Import-GroupPolicy {
    if ($script:gpModuleLoaded) { return }
    # PowerShell 7 lists a Windows PowerShell-only module such as GroupPolicy only with -SkipEditionCheck.
    $listed = if ($PSVersionTable.PSEdition -eq 'Core') { Get-Module -ListAvailable GroupPolicy -SkipEditionCheck } else { Get-Module -ListAvailable GroupPolicy }
    if (-not $listed) {
        throw [HelperError]::new('GroupPolicyModuleMissing', 'The GroupPolicy module is not installed. Install Group Policy Management (GPMC), which comes with RSAT.')
    }
    # On PowerShell 7 a plain import loads the module in a Windows PowerShell session and returns
    # deserialized objects. -SkipEditionCheck loads it in this process. The #3 probe found this.
    if ($PSVersionTable.PSEdition -eq 'Core') {
        try { Import-Module GroupPolicy -SkipEditionCheck -ErrorAction Stop -WarningAction SilentlyContinue }
        catch { Import-Module GroupPolicy -ErrorAction Stop -WarningAction SilentlyContinue }
    } else {
        Import-Module GroupPolicy -ErrorAction Stop
    }
    $script:gpModuleLoaded = $true
}

function Get-GpoTarget($a) {
    Import-GroupPolicy
    $domain = [string]$a.domain
    $server = (Get-Connection $domain).Pdc
    $id = [string]$a.gpo
    if (-not $id) { throw [HelperError]::new('BadRequest', 'gpo needs a GPO name or id') }
    $guid = [guid]::Empty
    $found = if ([guid]::TryParse($id.Trim('{}'), [ref]$guid)) {
        Get-GPO -Guid $guid -Domain $domain -Server $server -ErrorAction SilentlyContinue
    } else {
        Get-GPO -Name $id -Domain $domain -Server $server -ErrorAction SilentlyContinue
    }
    if (-not $found) { throw [HelperError]::new('NoSuchGpo', "No GPO named or with id '$id' in $domain.") }
    @{ Gpo = $found; Domain = $domain; Server = $server }
}

function ConvertTo-GpoSummary($g) {
    [ordered]@{
        id = $g.Id.ToString()
        name = $g.DisplayName
        status = [string]$g.GpoStatus
        created = $g.CreationTime.ToUniversalTime().ToString('o')
        modified = $g.ModificationTime.ToUniversalTime().ToString('o')
        computerVersion = [int]$g.Computer.DSVersion
        userVersion = [int]$g.User.DSVersion
        wmiFilter = if ($g.WmiFilter) { $g.WmiFilter.Name } else { $null }
    }
}

# Where a GPO is linked, from gPLink on each OU and on the domain head. In gPLink the last link
# listed applies first, so it has link order 1. Options: 1 = disabled, 2 = enforced.
function Get-GpoLinks([string]$domain, [string]$id) {
    $conn = Get-Connection $domain
    $req = New-SearchRequest $conn.DefaultNamingContext "(gPLink=*$id*)" ([System.DirectoryServices.Protocols.SearchScope]::Subtree) @('gPLink')
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($e in (Send-Request $domain $req).Entries) {
        $text = [string]$e.Attributes['gPLink'][0]
        $links = [regex]::Matches($text, '\[LDAP://[^;\]]*?\{(?<id>[0-9a-fA-F-]{36})\}[^;\]]*;(?<opt>\d+)\]')
        for ($i = 0; $i -lt $links.Count; $i++) {
            if ($links[$i].Groups['id'].Value -ne $id) { continue }
            $opt = [int]$links[$i].Groups['opt'].Value
            $out.Add([ordered]@{ target = $e.DistinguishedName; enabled = -not ($opt -band 1); enforced = [bool]($opt -band 2); order = $links.Count - $i })
        }
    }
    , $out.ToArray()
}

# Reads one null-terminated UTF-16 string from a Registry.pol buffer and moves $pos past it.
function Read-PolText([byte[]]$b, [ref]$pos) {
    $start = $pos.Value
    $i = $start
    while ($i + 1 -lt $b.Length -and -not ($b[$i] -eq 0 -and $b[$i + 1] -eq 0)) { $i += 2 }
    $pos.Value = $i + 2
    [Text.Encoding]::Unicode.GetString($b, $start, $i - $start)
}

# Registry.pol: "PReg", version 1, then entries [key;valueName;type;size;data], all UTF-16 except
# the type, size and data. Each bracket and semicolon is one UTF-16 character, two bytes.
function Read-RegistryPol([string]$path) {
    $out = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $path)) { return , $out.ToArray() }
    $b = [IO.File]::ReadAllBytes($path)
    if ($b.Length -lt 8 -or [BitConverter]::ToUInt32($b, 0) -ne 0x67655250) { throw [HelperError]::new('BadRegistryPol', "$path is not a Registry.pol file") }
    $u = [Text.Encoding]::Unicode
    $pos = 8
    while ($pos + 2 -le $b.Length) {
        $pos += 2                                         # [
        $key = Read-PolText $b ([ref]$pos); $pos += 2     # ;
        $name = Read-PolText $b ([ref]$pos); $pos += 2    # ;
        $type = [BitConverter]::ToUInt32($b, $pos); $pos += 6
        $size = [BitConverter]::ToUInt32($b, $pos); $pos += 6
        $data = New-Object byte[] $size
        [Array]::Copy($b, $pos, $data, 0, $size); $pos += $size
        $pos += 2                                         # ]
        $value = switch ($type) {
            { $_ -in 1, 2 } { $u.GetString($data).TrimEnd([char]0) }
            4 { if ($size -ge 4) { [BitConverter]::ToUInt32($data, 0) } else { $null } }
            11 { if ($size -ge 8) { [string][BitConverter]::ToUInt64($data, 0) } else { $null } }
            7 { , @($u.GetString($data).TrimEnd([char]0) -split [char]0) }
            default { @{ base64 = [Convert]::ToBase64String($data) } }
        }
        $typeName = switch ($type) { 1 { 'String' } 2 { 'ExpandString' } 3 { 'Binary' } 4 { 'DWord' } 7 { 'MultiString' } 11 { 'QWord' } default { "Type$type" } }
        $out.Add([ordered]@{ key = $key; valueName = $name; type = $typeName; value = $value })
    }
    , $out.ToArray()
}

# A GPO's security template, MACHINE\Microsoft\Windows NT\SecEdit\GptTmpl.inf: an INI file that
# Windows saves as UTF-16 with a BOM, which ReadAllLines follows. Each section's lines come back
# in order as [key, value], with a name for every *S-1-... SID in them. The binding gives them
# shape (src/core/sandbox/gpttmpl.ts). Issue #12.
function Read-GptTmpl([string]$path) {
    $sections = [ordered]@{}
    $names = @{}
    if (Test-Path -LiteralPath $path) {
        $current = $null
        foreach ($line in [IO.File]::ReadAllLines($path)) {
            $t = $line.Trim()
            if ($t -eq '' -or $t.StartsWith(';')) { continue }
            if ($t -match '^\[(.+)\]$') {
                $current = $Matches[1]
                if (-not $sections.Contains($current)) { $sections[$current] = New-Object System.Collections.Generic.List[object] }
                continue
            }
            if ($null -eq $current) { continue }
            $eq = $t.IndexOf('=')
            $key = if ($eq -lt 0) { $t } else { $t.Substring(0, $eq).Trim() }
            $value = if ($eq -lt 0) { '' } else { $t.Substring($eq + 1).Trim() }
            $sections[$current].Add(@($key, $value))
            foreach ($m in [regex]::Matches("$key,$value", '\*(S-1-[0-9-]+)')) {
                $sid = $m.Groups[1].Value
                if ($names.ContainsKey($sid)) { continue }
                $name = try { Get-SidName ([System.Security.Principal.SecurityIdentifier]::new($sid)) } catch { $null }
                if ($name) { $names[$sid] = $name }
            }
        }
    }
    [ordered]@{ sections = $sections; names = $names }
}

function Invoke-GpoList($a) {
    Import-GroupPolicy
    $domain = [string]$a.domain
    , @(Get-GPO -All -Domain $domain -Server (Get-Connection $domain).Pdc | Sort-Object DisplayName | ForEach-Object { ConvertTo-GpoSummary $_ })
}

function Invoke-GpoGet($a) {
    $t = Get-GpoTarget $a
    $id = $t.Gpo.Id.ToString()
    $root = "\\$($t.Server)\SYSVOL\$($t.Domain)\Policies\{$id}"
    $out = ConvertTo-GpoSummary $t.Gpo
    $out.links = Get-GpoLinks $t.Domain $id
    # HKLM settings live under Machine, HKCU settings under User.
    $out.computerSettings = Read-RegistryPol "$root\Machine\Registry.pol"
    $out.userSettings = Read-RegistryPol "$root\User\Registry.pol"
    $out.securityTemplate = Read-GptTmpl "$root\Machine\Microsoft\Windows NT\SecEdit\GptTmpl.inf"
    $out
}

function Invoke-GpoCreate($a) {
    Import-GroupPolicy
    $domain = [string]$a.domain
    if (-not $a.name) { throw [HelperError]::new('BadRequest', 'create needs a name') }
    $params = @{ Name = [string]$a.name; Domain = $domain; Server = (Get-Connection $domain).Pdc; ErrorAction = 'Stop' }
    if ($a.comment) { $params.Comment = [string]$a.comment }
    ConvertTo-GpoSummary (New-GPO @params)
}

function Invoke-GpoDelete($a) {
    $t = Get-GpoTarget $a
    Remove-GPO -Guid $t.Gpo.Id -Domain $t.Domain -Server $t.Server -ErrorAction Stop
    [ordered]@{ id = $t.Gpo.Id.ToString(); name = $t.Gpo.DisplayName; deleted = $true }
}

function Invoke-GpoLink($a) {
    $t = Get-GpoTarget $a
    if (-not $a.target) { throw [HelperError]::new('BadRequest', 'link needs a target DN') }
    $params = @{ Guid = $t.Gpo.Id; Target = [string]$a.target; Domain = $t.Domain; Server = $t.Server; ErrorAction = 'Stop' }
    if ($null -ne $a.enabled) { $params.LinkEnabled = $(if ($a.enabled) { 'Yes' } else { 'No' }) }
    if ($null -ne $a.enforced) { $params.Enforced = $(if ($a.enforced) { 'Yes' } else { 'No' }) }
    if ($a.order) { $params.Order = [int]$a.order }
    $existing = @(Get-GpoLinks $t.Domain $t.Gpo.Id.ToString()) | Where-Object { $_.target -eq [string]$a.target }
    if ($existing) { Set-GPLink @params | Out-Null } else { New-GPLink @params | Out-Null }
    [ordered]@{ id = $t.Gpo.Id.ToString(); links = Get-GpoLinks $t.Domain $t.Gpo.Id.ToString() }
}

function Invoke-GpoUnlink($a) {
    $t = Get-GpoTarget $a
    if (-not $a.target) { throw [HelperError]::new('BadRequest', 'unlink needs a target DN') }
    Remove-GPLink -Guid $t.Gpo.Id -Target ([string]$a.target) -Domain $t.Domain -Server $t.Server -ErrorAction Stop | Out-Null
    [ordered]@{ id = $t.Gpo.Id.ToString(); links = Get-GpoLinks $t.Domain $t.Gpo.Id.ToString() }
}

function Invoke-GpoSet($a) {
    $t = Get-GpoTarget $a
    foreach ($f in 'key', 'valueName', 'type') { if (-not $a.$f) { throw [HelperError]::new('BadRequest', "set needs $f") } }
    if ($null -eq $a.value) { throw [HelperError]::new('BadRequest', 'set needs value') }
    $type = [string]$a.type
    if ($type -notin 'String', 'ExpandString', 'DWord', 'QWord', 'MultiString') { throw [HelperError]::new('BadRequest', 'type must be String, ExpandString, DWord, QWord or MultiString') }
    $value = switch ($type) {
        'DWord' { [int][uint32]$a.value }
        'QWord' { [long][uint64]$a.value }
        'MultiString' { [string[]]@($a.value) }
        default { [string]$a.value }
    }
    Set-GPRegistryValue -Guid $t.Gpo.Id -Domain $t.Domain -Server $t.Server -Key ([string]$a.key) -ValueName ([string]$a.valueName) -Type $type -Value $value -ErrorAction Stop | Out-Null
    [ordered]@{ id = $t.Gpo.Id.ToString(); key = [string]$a.key; valueName = [string]$a.valueName; type = $type; value = $a.value }
}

function Invoke-GpoRemove($a) {
    $t = Get-GpoTarget $a
    if (-not $a.key) { throw [HelperError]::new('BadRequest', 'remove needs key') }
    $params = @{ Guid = $t.Gpo.Id; Domain = $t.Domain; Server = $t.Server; Key = [string]$a.key; ErrorAction = 'Stop' }
    if ($a.valueName) { $params.ValueName = [string]$a.valueName }
    Remove-GPRegistryValue @params | Out-Null
    [ordered]@{ id = $t.Gpo.Id.ToString(); key = [string]$a.key; valueName = $a.valueName }
}

function Invoke-GpoBackup($a) {
    $t = Get-GpoTarget $a
    if (-not $a.path) { throw [HelperError]::new('BadRequest', 'backup needs a folder path') }
    New-Item -ItemType Directory -Force -Path ([string]$a.path) | Out-Null
    $before = @(Get-ChildItem -LiteralPath ([string]$a.path) -Directory | ForEach-Object Name)
    Backup-GPO -Guid $t.Gpo.Id -Domain $t.Domain -Server $t.Server -Path ([string]$a.path) -ErrorAction Stop | Out-Null
    # Read the backup id from the folder Backup-GPO made. Its return object differs when PowerShell 7
    # loads the module with -SkipEditionCheck, and on the lab DC it had no Id.
    $made = Get-ChildItem -LiteralPath ([string]$a.path) -Directory | Where-Object { $_.Name -notin $before -and $_.Name -match '^\{[0-9A-Fa-f-]{36}\}$' } |
        Sort-Object CreationTime -Descending | Select-Object -First 1
    if (-not $made) { throw [HelperError]::new('BackupNotFound', "Backup-GPO finished but no new backup folder is in $($a.path).") }
    [ordered]@{ id = $t.Gpo.Id.ToString(); backupId = $made.Name.Trim('{}'); path = $made.FullName; timestamp = $made.CreationTimeUtc.ToString('o') }
}

# The policy settings a GPO can set, from the ADMX files: the domain's central store when it has
# one, otherwise this machine's PolicyDefinitions. Display names come from the en-US ADML files.
function Invoke-PolicyDefinitions($a) {
    $domain = [string]$a.domain
    $central = "\\$domain\SYSVOL\$domain\Policies\PolicyDefinitions"
    $dir = if (Test-Path -LiteralPath $central) { $central } else { Join-Path $env:SystemRoot 'PolicyDefinitions' }
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($file in Get-ChildItem -LiteralPath $dir -Filter *.admx) {
        try { [xml]$admx = [IO.File]::ReadAllText($file.FullName) } catch { continue }
        $strings = @{}
        $adml = Join-Path (Join-Path $dir 'en-US') ($file.BaseName + '.adml')
        if (Test-Path -LiteralPath $adml) {
            try {
                [xml]$lang = [IO.File]::ReadAllText($adml)
                foreach ($s in $lang.policyDefinitionResources.resources.stringTable.string) { $strings[$s.id] = $s.'#text' }
            } catch { }
        }
        $text = { param($ref) if ($ref -match '^\$\(string\.(.+)\)$') { $strings[$Matches[1]] } else { $ref } }
        $categories = @{}
        foreach ($c in $admx.policyDefinitions.categories.category) { $categories[$c.name] = & $text $c.displayName }
        foreach ($p in $admx.policyDefinitions.policies.policy) {
            $cat = [string]$p.parentCategory.ref
            $catName = ($cat -split ':')[-1]
            $elements = New-Object System.Collections.Generic.List[object]
            if ($p.elements) {
                foreach ($el in $p.elements.ChildNodes) {
                    if ($el.NodeType -ne 'Element') { continue }
                    $elements.Add([ordered]@{ type = $el.LocalName; id = $el.id; valueName = $el.valueName; key = $el.key })
                }
            }
            $out.Add([ordered]@{
                name = $p.name
                file = $file.BaseName
                displayName = & $text $p.displayName
                class = $p.class
                key = $p.key
                valueName = $p.valueName
                category = $(if ($categories[$catName]) { $categories[$catName] } else { $catName })
                elements = $elements.ToArray()
            })
        }
    }
    [ordered]@{ source = $dir; policies = $out.ToArray() }
}

# --- Editing a security template (ADR-0011) --------------------------------------------------
#
# Text in, text out: these change one key and leave every other line as it was (guardrail 1).
# Lines are joined with CRLF, as Windows writes them.

$InfSkeleton = @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1')

# The line range of a section: Header is the [Section] line, End is the next header or the end.
function Find-InfSection([string[]]$lines, [string]$section) {
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -ieq "[$section]") {
            $end = $i + 1
            while ($end -lt $lines.Count -and $lines[$end].Trim() -notmatch '^\[.+\]$') { $end++ }
            return @{ Header = $i; End = $end }
        }
    }
    $null
}

function Find-InfKey([string[]]$lines, $range, [string]$key) {
    for ($i = $range.Header + 1; $i -lt $range.End; $i++) {
        $eq = $lines[$i].IndexOf('=')
        if ($eq -gt 0 -and $lines[$i].Substring(0, $eq).Trim() -ieq $key) { return $i }
    }
    -1
}

function Get-InfValue([string]$text, [string]$section, [string]$key) {
    $lines = $text -split "\r?\n"
    $range = Find-InfSection $lines $section
    if (-not $range) { return $null }
    $at = Find-InfKey $lines $range $key
    if ($at -lt 0) { return $null }
    $lines[$at].Substring($lines[$at].IndexOf('=') + 1).Trim()
}

# Sets one key, or removes its line when $value is $null (left untyped: [string] would turn $null
# into ''). Registry Values lines are written key=value, the others key = value, as Windows does.
function Set-InfValue([string]$text, [string]$section, [string]$key, $value) {
    $lines = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrEmpty($text)) {
        if ($null -eq $value) { return $text }
        $lines.AddRange([string[]]$InfSkeleton); $lines.Add('')
    } else { $lines.AddRange([string[]]($text -split "\r?\n")) }
    $sep = if ($section -ieq 'Registry Values') { '=' } else { ' = ' }
    $range = Find-InfSection $lines.ToArray() $section
    $at = if ($range) { Find-InfKey $lines.ToArray() $range $key } else { -1 }
    if ($null -eq $value) {
        if ($at -lt 0) { return $text }
        $lines.RemoveAt($at)
    } elseif ($at -ge 0) {
        $lines[$at] = $lines[$at].Substring(0, $lines[$at].IndexOf('=')).Trim() + $sep + $value
    } elseif ($range) {
        # After the section's last non-blank line, so a blank line before the next header stays put.
        $insert = $range.End
        while ($insert -gt $range.Header + 1 -and $lines[$insert - 1].Trim() -eq '') { $insert-- }
        $lines.Insert($insert, "$key$sep$value")
    } else {
        $insert = if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.Count - 1 } else { $lines.Count }
        $lines.InsertRange($insert, [string[]]@("[$section]", "$key$sep$value"))
    }
    $lines.ToArray() -join "`r`n"
}

# A user right's list with one SID added or removed. Entries are *S-1-... or account names; a name
# that resolves to the SID counts as the SID. The other entries keep their order.
function Edit-RightList([string]$current, [string]$sid, [bool]$grant) {
    $entries = @($current -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $same = {
        param($entry)
        if ($entry.StartsWith('*')) { return $entry.Substring(1) -ieq $sid }
        try { (Resolve-Principal $entry).Value -ieq $sid } catch { $false }
    }
    $matched = @($entries | Where-Object { & $same $_ })
    if ($grant) {
        if ($matched.Count -gt 0) { return ($entries -join ',') }
        return ((@($entries) + "*$sid") -join ',')
    }
    (@($entries | Where-Object { -not (& $same $_) }) -join ',')
}

$SecurityCsePair = '[{827D319E-6EAC-11D2-A4EA-00C04F79F83A}{803E14A0-B4FB-11D0-A0D0-00A0C90F574B}]'

# Where a GPO stands: its version in AD and in GPT.INI, its extensions, and its security template.
# Paths go to SYSVOL on the PDC emulator, as every call does (ADR-0006).
function Get-GpoSecurityState($t) {
    $id = $t.Gpo.Id.ToString()
    $gpcDn = "CN={$id},CN=Policies,CN=System,$((Get-Connection $t.Domain).DefaultNamingContext)"
    $req = New-SearchRequest $gpcDn '(objectClass=*)' ([System.DirectoryServices.Protocols.SearchScope]::Base) @('versionNumber', 'gPCMachineExtensionNames')
    $e = (Send-Request $t.Domain $req).Entries[0]
    $cse = ''
    if ($e.Attributes['gPCMachineExtensionNames']) { $cse = [string]$e.Attributes['gPCMachineExtensionNames'][0] }
    $root = "\\$($t.Server)\SYSVOL\$($t.Domain)\Policies\{$id}"
    $ini = "$root\GPT.INI"
    $iniLines = @()
    if (Test-Path -LiteralPath $ini) { $iniLines = @([IO.File]::ReadAllLines($ini)) }
    $iniVersion = 0
    foreach ($l in $iniLines) { if ($l -match '^\s*Version\s*=\s*(\d+)\s*$') { $iniVersion = [long]$Matches[1] } }
    $inf = "$root\Machine\Microsoft\Windows NT\SecEdit\GptTmpl.inf"
    $exists = Test-Path -LiteralPath $inf
    $text = ''
    if ($exists) { $text = [IO.File]::ReadAllText($inf) }
    @{ Id = $id; GpcDn = $gpcDn; Version = [long]$e.Attributes['versionNumber'][0]; Cse = $cse
       IniPath = $ini; IniLines = $iniLines; IniVersion = $iniVersion; InfPath = $inf; InfExists = $exists; Text = $text }
}

# Applies $change (old template text in, new text out) under ADR-0011's guardrails. Returns
# @{ Changed; Text }. -BeforeVersionBump runs between writing the file and raising the version;
# only spike/gpo-security-guard.ps1 passes it, to stand for someone else editing the GPO.
function Write-GpoSecurity($t, [scriptblock]$change, [scriptblock]$BeforeVersionBump = $null) {
    $s = Get-GpoSecurityState $t
    # Guardrail 3: a GPO whose two versions already disagree is out of step; don't add to it.
    if ($s.Version -ne $s.IniVersion) {
        throw [HelperError]::new('GpoVersionMismatch', "GPO {$($s.Id)} has version $($s.Version) in AD and $($s.IniVersion) in GPT.INI, so it is already out of step. Nothing was changed. Open it in GPMC and save it, or ask its owner, before changing its security settings (ADR-0011).")
    }
    $newText = & $change $s.Text
    if ($newText -ceq $s.Text) { return @{ Changed = $false; Text = $s.Text } }

    # Guardrail 2: UTF-16 with a BOM, as Windows saves it.
    New-Item -ItemType Directory -Force -Path (Split-Path $s.InfPath) | Out-Null
    [IO.File]::WriteAllText($s.InfPath, $newText, [Text.Encoding]::Unicode)
    if ($BeforeVersionBump) { & $BeforeVersionBump }

    # Guardrails 4, 5 and 6 in one modify: deleting versionNumber=V fails if someone else raised it
    # since it was read, so the version only moves if nobody else got there first.
    $next = $s.Version + 1
    $pairs = @([regex]::Matches($s.Cse, '\[[^\]]+\]') | ForEach-Object { $_.Value })
    if ($pairs -notcontains $SecurityCsePair) { $pairs += $SecurityCsePair }
    $req = New-Object "$Sdp.ModifyRequest"
    $req.DistinguishedName = $s.GpcDn
    foreach ($m in @(
        @{ Name = 'versionNumber'; Op = 'Delete'; Value = [string]$s.Version },
        @{ Name = 'versionNumber'; Op = 'Add'; Value = [string]$next },
        @{ Name = 'gPCMachineExtensionNames'; Op = 'Replace'; Value = (($pairs | Sort-Object) -join '') })) {
        $mod = New-Object "$Sdp.DirectoryAttributeModification"
        $mod.Name = $m.Name
        $mod.Operation = [System.DirectoryServices.Protocols.DirectoryAttributeOperation]::($m.Op)
        [void]$mod.Add([string]$m.Value)
        [void]$req.Modifications.Add($mod)
    }
    try {
        [void](Send-Request $t.Domain $req)
    } catch {
        $err = $_
        # Put the old template back, but only if the file is still ours: if someone else wrote it in
        # the meantime, theirs stays.
        if ((Test-Path -LiteralPath $s.InfPath) -and [IO.File]::ReadAllText($s.InfPath) -ceq $newText) {
            if ($s.InfExists) { [IO.File]::WriteAllText($s.InfPath, $s.Text, [Text.Encoding]::Unicode) }
            else { Remove-Item -LiteralPath $s.InfPath -ErrorAction SilentlyContinue }
        }
        $ex = Get-InnerException $err.Exception
        if ($ex -is [System.DirectoryServices.Protocols.DirectoryOperationException] -and $ex.Response -and [string]$ex.Response.ResultCode -in 'NoSuchAttribute', 'AttributeOrValueExists', 'ConstraintViolation') {
            throw [HelperError]::new('GpoChanged', "GPO {$($s.Id)} changed while adslayer was writing it (its version is no longer $($s.Version)). Nothing was changed. Read it again and retry.")
        }
        throw $err
    }

    # GPT.INI follows AD, keeping its other lines.
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.AddRange([string[]]$s.IniLines)
    $at = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*Version\s*=') { $at = $i } }
    if ($at -ge 0) { $lines[$at] = "Version=$next" }
    else {
        if (-not ($lines | Where-Object { $_.Trim() -ieq '[General]' })) { $lines.Add('[General]') }
        $lines.Add("Version=$next")
    }
    [IO.File]::WriteAllText($s.IniPath, (($lines.ToArray() -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)

    # Guardrail 7: read it back.
    if ([IO.File]::ReadAllText($s.InfPath) -cne $newText) {
        throw [HelperError]::new('GpoWriteNotVerified', "GPO {$($s.Id)}'s security template did not read back as written. Check it in GPMC.")
    }
    @{ Changed = $true; Text = $newText }
}

function Get-RightEntries($value) { @(([string]$value) -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

# gpo.grant and gpo.revoke: one principal on one user right. Revoking the last principal removes the
# right's line, so the GPO no longer defines it (decided 2026-10-03).
function Invoke-GpoRight($a, [bool]$grant) {
    $t = Get-GpoTarget $a
    $right = [string]$a.right
    if ($right -notmatch '^Se\w+(Right|Privilege)$') { throw [HelperError]::new('BadRequest', "right must be a user right such as SeServiceLogonRight, not '$right'") }
    $sid = (Resolve-Principal ([string]$a.principal)).Value
    $r = @{ Before = $null; After = $null }
    $w = Write-GpoSecurity $t {
        param($text)
        $r.Before = Get-InfValue $text 'Privilege Rights' $right
        if ($null -eq $r.Before -and -not $grant) { $r.After = $null; return $text }
        $list = Edit-RightList ([string]$r.Before) $sid $grant
        $r.After = if ($list -eq '') { $null } else { $list }
        if ($null -ne $r.Before -and $r.After -ceq $r.Before) { return $text }
        Set-InfValue $text 'Privilege Rights' $right $r.After
    }
    # @() because a function's output unrolls: one entry would arrive as a string, none as $null.
    $before = @(Get-RightEntries $r.Before)
    $after = @(Get-RightEntries $r.After)
    $names = @{}
    foreach ($entry in @($before) + @($after) + "*$sid") {
        if ($entry.StartsWith('*') -and -not $names.ContainsKey($entry.Substring(1))) {
            $n = try { Get-SidName ([System.Security.Principal.SecurityIdentifier]::new($entry.Substring(1))) } catch { $null }
            if ($n) { $names[$entry.Substring(1)] = $n }
        }
    }
    $defined = if ($null -eq $r.After) { $false } elseif ($null -eq $r.Before) { 'new' } else { $true }
    [ordered]@{ id = $t.Gpo.Id.ToString(); right = $right; sid = $sid; changed = $w.Changed; defined = $defined; before = $before; after = $after; names = $names }
}

# gpo.setSecurity: one key in [System Access] or [Registry Values]. The binding has checked the key
# and encoded the value as the template writes it, e.g. 14, "Admin" or 4,1.
function Invoke-GpoSetSecurity($a) {
    $t = Get-GpoTarget $a
    $section = [string]$a.section
    if ($section -notin 'System Access', 'Registry Values') { throw [HelperError]::new('BadRequest', 'section must be System Access or Registry Values') }
    if (-not $a.key -or $null -eq $a.value) { throw [HelperError]::new('BadRequest', 'setSecurity needs key and value') }
    $key = [string]$a.key
    $value = [string]$a.value
    $r = @{ Before = $null }
    $w = Write-GpoSecurity $t {
        param($text)
        $r.Before = Get-InfValue $text $section $key
        if ($r.Before -ceq $value) { return $text }
        Set-InfValue $text $section $key $value
    }
    [ordered]@{ id = $t.Gpo.Id.ToString(); section = $section; key = $key; changed = $w.Changed; before = $r.Before; after = $value }
}

# --- Other ops ------------------------------------------------------------------------------

function Invoke-WhoAmI($a) {
    $resp = Send-Request ([string]$a.domain) (New-Object "$Sdp.ExtendedRequest" '1.3.6.1.4.1.4203.1.11.3')
    $conn = Get-Connection ([string]$a.domain)
    [ordered]@{ user = $utf8.GetString($resp.ResponseValue); pdc = $conn.Pdc; defaultNamingContext = $conn.DefaultNamingContext }
}

# The rootDSE of the domain's PDC emulator: where the schema and configuration live, and what the
# DC supports. The catalogue reads it (ADR-0010).
function Invoke-RootDse($a) {
    $req = New-SearchRequest '' '(objectClass=*)' ([System.DirectoryServices.Protocols.SearchScope]::Base) @(
        'defaultNamingContext', 'schemaNamingContext', 'configurationNamingContext', 'rootDomainNamingContext',
        'dnsHostName', 'supportedControl', 'supportedCapabilities', 'domainFunctionality', 'forestFunctionality')
    (Read-Entry ([string]$a.domain) (Send-Request ([string]$a.domain) $req).Entries[0]).attributes
}

function Invoke-Hello {
    [ordered]@{
        helper = 'adslayer-helper'
        protocol = 1
        psVersion = $PSVersionTable.PSVersion.ToString()
        psEdition = $PSVersionTable.PSEdition
        user = Get-LogonUser
    }
}

# --- Loop -----------------------------------------------------------------------------------

function Get-ErrorAnswer($err) {
    $ex = Get-InnerException $err.Exception
    if ($ex -is [HelperError]) { return @{ code = $ex.Code; message = $ex.Message } }
    if ($ex -is [System.DirectoryServices.Protocols.DirectoryOperationException]) {
        $code = if ($ex.Response) { [string]$ex.Response.ResultCode } else { 'DirectoryOperationError' }
        $detail = if ($ex.Response -and $ex.Response.ErrorMessage) { " ($($ex.Response.ErrorMessage -replace '[\x00\s]+$', ''))" } else { '' }
        return @{ code = $code; message = "$($ex.Message)$detail" }
    }
    if ($ex -is [System.DirectoryServices.Protocols.LdapException]) {
        return @{ code = "Ldap$($ex.ErrorCode)"; message = "$($ex.Message) $($ex.ServerErrorMessage)".Trim() }
    }
    # The GroupPolicy cmdlets report a refusal as a COM or access exception, not an LDAP result.
    if ($ex -is [UnauthorizedAccessException] -or $ex.HResult -eq -2147024891 -or $ex.Message -match '0x80070005|E_ACCESSDENIED') {
        return @{ code = 'AccessDenied'; message = $ex.Message }
    }
    # Anything else is a fault in the helper itself, so say where.
    @{ code = 'HelperError'; message = "$($ex.Message) (adslayer-helper.ps1 line $($err.InvocationInfo.ScriptLineNumber))" }
}

Write-Log "ready (PowerShell $($PSVersionTable.PSVersion), $(Get-LogonUser))"
while ($null -ne ($line = $stdin.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $id = $null
    try {
        try { $msg = $line | ConvertFrom-Json } catch { throw [HelperError]::new('BadRequest', 'the request is not valid JSON') }
        $id = $msg.id
        $a = $msg.args
        $value = switch ([string]$msg.op) {
            'hello' { Invoke-Hello }
            'whoami' { Invoke-WhoAmI $a }
            'rootdse' { Invoke-RootDse $a }
            'gpo.list' { Invoke-GpoList $a }
            'gpo.get' { Invoke-GpoGet $a }
            'gpo.create' { Invoke-GpoCreate $a }
            'gpo.delete' { Invoke-GpoDelete $a }
            'gpo.link' { Invoke-GpoLink $a }
            'gpo.unlink' { Invoke-GpoUnlink $a }
            'gpo.set' { Invoke-GpoSet $a }
            'gpo.remove' { Invoke-GpoRemove $a }
            'gpo.backup' { Invoke-GpoBackup $a }
            'gpo.grant' { Invoke-GpoRight $a $true }
            'gpo.revoke' { Invoke-GpoRight $a $false }
            'gpo.setSecurity' { Invoke-GpoSetSecurity $a }
            'policydefinitions' { Invoke-PolicyDefinitions $a }
            'search' { Invoke-Search $a }
            'add' { Invoke-Add $a }
            'modify' { Invoke-Modify $a }
            'delete' { Invoke-Delete $a }
            'move' { Invoke-Move $a }
            'acl.get' { Invoke-AclGet $a }
            'acl.add' { Invoke-AclChange $a $true }
            'acl.remove' { Invoke-AclChange $a $false }
            default { throw [HelperError]::new('BadRequest', "unknown op '$($msg.op)'") }
        }
        Write-Answer ([ordered]@{ id = $id; ok = $true; value = $value })
    } catch {
        Write-Answer ([ordered]@{ id = $id; ok = $false; error = (Get-ErrorAnswer $_) })
    }
}
foreach ($k in @($script:connections.Keys)) { Reset-Connection $k }
