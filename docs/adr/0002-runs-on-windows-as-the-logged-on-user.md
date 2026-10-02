# Runs on Windows as the logged-on user

adslayer runs only on a Windows machine that is joined to the domain, and every call runs as the Windows user who is signed in, through Kerberos with signing and sealing. The server never stores a password or a certificate. Arnold chose this on 2026-10-01.

The reason is that a password sign-in was the only option a pure JavaScript client could do. The only maintained Node LDAP client, `ldapts` 9.2.0, supports simple bind and SASL EXTERNAL. It cannot do Kerberos or NTLM, and it has no signing or sealing layer. With a simple bind, the server would keep a domain password in a keychain, and that password would often belong to an administrator. With the logged-on user, there is no secret for the server to lose, and the domain's own logs name the person who made each change.

## Considered options

- **Simple bind over LDAPS from any machine, macOS included, with the password in the keychain.** We rejected it for the reason above. Windows Server 2025 also refuses a simple bind on an unencrypted connection, and it needs an encrypted session to read confidential attributes. Signing in this way would work over LDAPS, but we would still be storing an administrator's password.
- **A separate service account per connection.** We rejected it because it brings back a stored password.

## Consequences

- adslayer does not run on macOS or Linux. Unit tests use a fake helper so that they can run on any OS.
- What a person can do through adslayer is exactly what their Active Directory account can do. If they run it while signed in as a Domain Admin, it can do what a Domain Admin can do.
- A connection holds no credential, so adding one needs no browser and no terminal step.
