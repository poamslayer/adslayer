# LDAP goes through a PowerShell helper

The Node server does not speak LDAP itself. When the `execute` binding gets a call, it sends the call to a PowerShell process that stays running. That process uses .NET's `System.DirectoryServices.Protocols` library, which comes with Windows. This library signs in with Negotiate as the logged-on user and turns on signing and sealing. The same process runs the GroupPolicy module for GPO changes (ADR-0007). The helper uses PowerShell 7 when it is installed and Windows PowerShell 5.1 when it is not. Arnold chose this on 2026-10-01.

This keeps graphslayer's sandbox and server unchanged, and adslayer needs nothing installed beyond what Windows Server and RSAT already have.

## Considered options

- **ldapts with the native `kerberos` package.** The `kerberos` package can produce Kerberos tokens through SSPI on Windows. But ldapts cannot carry a bind that takes more than one step, and it cannot seal a session. We would have to patch ldapts and keep maintaining that patch.
- **Rewriting the server in C#.** LDAP would be easiest from .NET, but we would lose the workerd sandbox and need to build a new one.

## Consequences

- Each call crosses from Node to PowerShell and back. The helper keeps its LDAP connection open between calls, so the cost is the round trip on the local machine and not a new sign-in.
- The helper has two PowerShell versions to support, so tests must run on both.
