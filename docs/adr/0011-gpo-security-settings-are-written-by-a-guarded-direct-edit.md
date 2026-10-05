# GPO security settings are written by a guarded direct edit

This changes part of ADR-0007, which rejected editing `GptTmpl.inf` directly. Arnold chose this on 2026-10-02, after the lab experiments below.

A GPO's security settings are in its security template, `Machine\Microsoft\Windows NT\SecEdit\GptTmpl.inf` in SYSVOL. They include password and lockout policy, user rights, Security Options and Restricted Groups. The GroupPolicy module can't write them, so ADR-0007 left them read-only. Issue #12 added reading them. This ADR covers how adslayer writes them.

adslayer writes the file itself, with these guardrails:

1. It changes only the key it was asked to change, and keeps every other line and section as they are.
2. It saves the file as UTF-16 with a BOM, as Windows does.
3. It refuses to write to a GPO whose AD and SYSVOL computer versions already disagree, because that GPO is already out of step.
4. It raises the computer half of the version by one, in AD's `versionNumber` and in `GPT.INI`, to the same value.
5. It adds the security extension pair `[{827D319E-6EAC-11D2-A4EA-00C04F79F83A}{803E14A0-B4FB-11D0-A0D0-00A0C90F574B}]` to `gPCMachineExtensionNames` if it's missing, keeping the list sorted.
6. It guards against a concurrent edit. It raises `versionNumber` with one LDAP modify that deletes the old value and adds the new one. If someone else changed the GPO in the meantime, the old value is gone, the modify fails, and adslayer writes back the file it replaced. It writes it back only if the file still holds what adslayer wrote, so that a file someone else wrote in the meantime stays. Issue #16 added this condition.
7. It reads the file back and parses it to check the change.
8. It answers with the value it replaced, so the dont-nuke-prod skills can record the change and undo it. The server makes no backup (ADR-0004).
9. It writes to SYSVOL on the PDC emulator, as every other call does (ADR-0006).
10. A user right is changed one principal at a time, with grant and revoke. No call replaces a whole list. This was decided on 2026-10-02, when issue #3 was split.

## Evidence

`spike/gpo-security-write.ps1` ran on the lab DC on 2026-10-02 (issue #13). The setting was `SeTimeZonePrivilege`, granted to Remote Desktop Users on top of the DC's current holders. "Applies" means that, after `gpupdate /force`, the DC's local security database holds the SID, because the security extension writes the rights it applies there. The script resets that right before the experiments.

```text
PASS A1 Import-GPO raises the version of a GPO that had no security settings -- ad 0 -> 65537; ds 1 sysvol 1
FAIL A1 Import-GPO registers the security extension -- gPCMachineExtensionNames: ''
FAIL A1 Import-GPO copies the edited GptTmpl.inf into SYSVOL --
PASS A1b with the extension added to Backup.xml, Import-GPO registers it -- gPCMachineExtensionNames: '[{827D319E-…}{803E14A0-…}]'
FAIL A1b and copies GptTmpl.inf into SYSVOL --
FAIL A2 the right applies on dc01 after gpupdate -- RSoP: right not listed; local database: *S-1-5-19,*S-1-5-32-544,*S-1-5-32-549
WARN A4 without a guard, an edit made between backup and import is -- lost: the import replaced it
PASS A4 a version check before the import catches the edit and skips the import -- ad 196612 at backup, 196613 before import
PASS B1 AD and SYSVOL versions agree, and the security extension is registered -- ds 1 sysvol 1
PASS B1 the right applies on dc01 after gpupdate -- RSoP: right listed; local database: …,*S-1-5-32-555
PASS B1 GPMC report shows the right
PASS A6 on a GPO that already has a GptTmpl.inf, Import-GPO copies the edit and it applies -- copied: True
PASS B2 lab.delegated can write GptTmpl.inf, GPT.INI and versionNumber on Lab Baseline -- ds 47 sysvol 47
```

The experiments tested guardrails 2, 4 and 5 (B1), and that a delegated editor has the rights (B2). Issue #16 tested the others on the lab when it built the write calls:

- 1 and 7: `spike/e2e-mcp.mjs` checks that a change adds or replaces one line and leaves the rest.
- 3: the same run checks that a GPO with mismatched versions is refused.
- 6: `spike/gpo-security-guard.ps1` checks three cases. A write that loses the race removes the template it created. It writes back the old template. It keeps a template someone else wrote.

## Considered options

- **Back up, edit the backup, `Import-GPO` it back (path A).** This was the first choice, because Microsoft's module would keep the versions and extension GUIDs right. We rejected it.
  - On a GPO with no security template, which is most GPOs, `Import-GPO` silently left the edited `GptTmpl.inf` out, even with the extension added to `Backup.xml` (A1, A1b). It carried the file only when the backup already had one (A6). The likely cause is that `Backup.xml` lists the files of each extension, and that list is undocumented. Making path A work would mean editing it by hand.
  - An import also replaces every setting in the GPO. A change someone else made between the backup and the import was lost (A4), so path A needed a version guard anyway.
- **Leave security settings read-only.** We rejected it, because Arnold wants the agent to change them.

## Consequences

- adslayer owns the version and extension bookkeeping that ADR-0007 wanted Microsoft's module to own. The guardrails above are that bookkeeping, and lab runs check them: `spike/run-gpo-security-write.ps1`, `spike/run-gpo-security-guard.ps1` and `spike/run-e2e-on-lab.ps1`.
- A user right set by a GPO stays set on a computer after the GPO stops setting it. This is called tattooing, and the lab showed it: the right stayed on `dc01` after the test GPOs were deleted. Undoing a change means setting the old value, not removing the new one.
- A delegated editor who can edit a GPO in GPMC can write its security settings too (B2). The domain's own permissions still decide (ADR-0004).
- The machine that runs adslayer needs SMB access to SYSVOL on the PDC emulator, which the GroupPolicy cmdlets need already.
