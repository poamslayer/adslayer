# Directory data goes to the model provider

Whatever a script returns goes into the model's context, and so to the model provider. With adslayer that is usually a client's directory data, e.g., names, account names and group memberships. We accept this, as graphslayer does. A script returns only the small result it was written to return, not the raw objects. The README says plainly where results go, and the engagement terms with the client have to cover it. Arnold chose this on 2026-10-01.

## Considered options

- **Masking names in the server.** A connection setting would hide names and account names before the result reaches the model. We left it for later, as a backlog issue, because doing it well is a separate project.
- **Using adslayer only in labs and our own domains.** We rejected it because client domains are the main use.
