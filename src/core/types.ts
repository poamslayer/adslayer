export type ConnectionMode = "read" | "write";

/**
 * One domain the server can reach. It holds no credential: every call runs as the logged-on
 * user through Kerberos (ADR-0002), so adding one needs no sign-in (ADR-0005).
 */
export interface Connection {
  alias: string;
  /** The domain's DNS name, e.g. `contoso.local`. */
  domain: string;
  /** Absent means read. `modeOf` is the one place that decides that. ADR-0004. */
  mode?: ConnectionMode;
  addedAt: string;
}

/** One call a script made, as `execute` reports it back. */
export interface AdCallRecord {
  op: string;
  /** The DN the call named, or the search base. */
  target: string;
  ok: boolean;
  /** The helper's error code when the call failed, e.g. InsufficientAccessRights. */
  code?: string;
  ms: number;
}
