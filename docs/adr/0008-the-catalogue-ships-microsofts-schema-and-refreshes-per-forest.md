# The catalogue ships Microsoft's schema and refreshes per forest

**Superseded by ADR-0010 on 2026-10-02.** The catalogue is now read live from the domain.

`search` runs over a catalogue that ships with the server, so it needs no connection, as graphslayer's `search` does. The catalogue holds these:

- the schema, built from Microsoft's schema export files in Samba's `source4/setup/ad-schema/` folder, version 1903 (schema version 88)
- the LDAP controls listed on Microsoft Learn's rootDSE page
- the extended rights listed on Microsoft Learn's Control Access Rights page

A catalogue refresh reads the schema and the Group Policy definitions from one connection, which adds that forest's extensions, e.g., LAPS or Exchange attributes, along with the Windows Server 2025 schema changes and the policy settings it can set. Arnold chose this on 2026-10-01.

The schema files carry Microsoft's Open Specifications notice, which allows distributing the schemas inside an implementation. Samba's licence file says to ship them as part of an implementation and not alone. So the derived file ships inside the npm package with Microsoft's notice and its own licence. It is not published as a separate dataset. This is our reading and not legal advice, and it needs checking before the package is public.

## Considered options

- **The shipped catalogue only.** We rejected it because it misses forest extensions and the Windows Server 2025 schema changes.
- **A live catalogue only.** We rejected it because `search` would then need a connection.
