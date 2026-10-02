# Forked from graphslayer, with the same three tools

adslayer is a copy of graphslayer's code, not a shared package. We kept the parts that do not depend on Graph:

- the workerd sandbox
- the connection store
- the MCP server and the stdio transport
- the `docs` tool

We replaced the Graph sign-in, the Graph client and the Graph index. The tools are the same three, `docs`, `search` and `execute`, plus the tools that list, add and remove connections. Every read and every write, including GPO changes, goes through the one `execute` tool. Arnold chose this on 2026-10-01.

## Considered options

- **A shared core package used by both servers.** We rejected it for now. Graph names run through graphslayer's core, e.g., its `Connection`, `Cloud` and call record types, and its sandbox worker is a string template that names `graph`. A shared package designed from one example would guess at the boundary. We can extract one once both servers exist.
- **One server with two backends.** We rejected it. A Graph connection and an Active Directory connection have different sign-in models and different trust models, and they do not belong in one connection list.
- **Separate tools for GPOs or for writes.** We rejected them, as graphslayer did in its ADR-0017.

## Consequences

- A fix to the sandbox or the server in one repo has to be copied to the other by hand.
