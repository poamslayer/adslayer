# The agent can add a write connection

The `connection_add` tool accepts `mode: write`, so the agent can make a domain writable without a person typing a command. The only check is the MCP client's own prompt to approve the tool call, if the client is set to ask. Arnold chose this on 2026-10-01. It is the person's responsibility what account they run adslayer as and which tool calls they approve.

This differs from graphslayer, where a read-write connection needs a person to sign in and consent in a browser. adslayer has no sign-in step (ADR-0002), so nothing else stops the agent.

## Considered options

- **Write mode set only from the terminal.** This was the recommendation. It would stop text stored in the domain from turning on writes. For example, a user could write an instruction into their own `description` attribute, a read script could return that text to the agent, and the agent could follow it by adding a write connection. We rejected terminal-only write mode and accept that risk.

## Consequences

- A person who wants writes to need a terminal step can add only read connections and deny `connection_add` calls in their MCP client.
