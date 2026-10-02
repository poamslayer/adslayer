# The server is the hands, and the skills hold change management

The only limit the server puts on a write is the connection's mode. A read connection refuses every add, modify, delete, move and GPO change inside the binding, before anything is sent. A write connection sends whatever the script asks for, and Active Directory permissions decide the rest. The server has no dry run, no confirmation step, no backup step and no local audit log. Arnold decided this on 2026-10-01: "MCP is simply the hands."

The steps that make a change safe live in the yoloslayer skills, which are a separate repo. They include these:

- checking that the Recycle Bin is on before a delete
- running `Backup-GPO` before a GPO change
- reading the current values and showing the planned diff before a write
- checking the result afterward
- writing a change record

The record of what changed is Active Directory's own security log, i.e., the Directory Service Changes events, together with the change record the skill writes. This follows graphslayer's ADR-0012, ADR-0016 and ADR-0017.

## Considered options

- **Refusing a delete in the server when the Recycle Bin is off.** We first chose this and then moved it to the skills, so that the server has one rule and not a growing list of special cases.
- **A preview and a confirmation in the server.** graphslayer removed this in its ADR-0017, and we did not bring it back.

## Consequences

- An agent that runs without the yoloslayer skills gets no backup, no preview and no check on the Recycle Bin.
- If Directory Service Changes auditing is off in a domain, Active Directory keeps no record of attribute changes. The yoloslayer change record is then the only record.
