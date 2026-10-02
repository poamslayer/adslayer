# The catalogue is read live from the domain

This replaces ADR-0008. `search` no longer runs over a catalogue that ships with the server. The server reads the catalogue from the connected domain the first time `search` names that domain, and keeps it for the rest of the session. `search` takes a domain argument, the same as `execute`. Arnold chose this on 2026-10-02.

The catalogue holds these, all read from the domain:

- the schema: every class and every attribute, with each attribute's syntax, whether it holds one value, and whether it is confidential
- the LDAP controls the domain controller lists in its rootDSE
- the extended rights in the configuration partition

The reason is that ADR-0008 needed us to ship a file derived from Microsoft's schema export files in Samba's repo, and we had not checked that the licences allow publishing it on npm. Every domain already holds its own schema, so reading it removes the question. It is also more accurate, because it includes what that forest added, e.g., LAPS or Exchange attributes, and the Windows Server 2025 changes.

## Considered options

- **Ship the derived schema file (ADR-0008).** We rejected it until someone checks the licences.
- **Ship the file and refresh it from the domain.** We rejected it for the same reason.

## Consequences

- `search` needs a connection, and the first `search` for a domain in a session waits for the schema read, which takes a few seconds.
- `search` with `refresh: true` reads the domain again, e.g., after a schema extension.
- The catalogue never leaves the machine except as what a script returns, as with `execute` (ADR-0009).
