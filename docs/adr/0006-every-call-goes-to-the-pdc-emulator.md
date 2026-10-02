# Every call goes to the PDC emulator

Every read and every write for a connection goes to the domain's PDC emulator. The server does not use the DC locator to pick the nearest domain controller. Arnold chose this on 2026-10-01.

The reason is that a read right after a write sees the write, because both go to the same domain controller. The Group Policy Management Console also writes GPOs to the PDC emulator by default, so LDAP changes and GPO changes go to the same place.

## Considered options

- **Locate a writable domain controller once and pin it.** This was the recommendation. It spreads load across domain controllers.
- **Locate a domain controller on every call.** We rejected it because a read can reach a domain controller that has not yet received a write.

## Consequences

- If the PDC emulator is down or unreachable, adslayer cannot reach the domain, even though other domain controllers are up.
- All of adslayer's load in a domain lands on one domain controller.
