/**
 * What the `ad` binding sends LDAP calls to. The transport supplies one: on Windows, the PowerShell
 * helper (ADR-0003); in tests, a fake. `src/core` does not know which, so it never spawns anything.
 */
export interface LdapBackend {
  /** Sends one op for one domain. Resolves with the helper's value, or rejects with LdapError. */
  call(domain: string, op: string, args: Record<string, unknown>): Promise<unknown>;
}

/** An answer from the helper with `ok: false`. `code` is LDAP's result code name, e.g. NoSuchObject. */
export class LdapError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LdapError";
  }
}
