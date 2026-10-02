# GPO changes use the GroupPolicy module

Scripts change GPOs through the `gpo` object in `execute`. The helper carries out each change with Microsoft's GroupPolicy PowerShell module. That covers creating a GPO, linking and unlinking it, and setting policy settings. The module updates the GPO's version numbers and its extension GUIDs, which a direct file edit would have to get right by hand. Arnold chose this on 2026-10-01.

## Considered options

- **Editing `Registry.pol` and `GptTmpl.inf` in SYSVOL over SMB, and updating the version numbers ourselves.** This would cover more settings, including security template settings. We rejected it because a mistake there can break a GPO for every computer it applies to.
- **Reading GPOs in v1 and writing them later.** We rejected it because writing GPO settings is part of what a general admin tool has to do.

## Consequences

- The machine that runs adslayer needs the Group Policy Management feature, which comes with RSAT. Without it, the `gpo` calls fail with a message that names the missing feature.
- Security template settings, e.g., user rights assignments and password policy in a GPO, cannot be changed in v1.
