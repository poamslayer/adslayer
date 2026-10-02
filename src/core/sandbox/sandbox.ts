export interface RunLimits {
  timeoutMs?: number;
  maxLogLines?: number;
  maxLogChars?: number;
}

export interface RunResult {
  ok: boolean;
  data?: unknown;
  /** `line` is the failing line of the script itself, counting the script's own first line as 1. */
  error?: { name: string; message: string; stack?: string; line?: number };
  logs: string[];
}

/** Called by the sandbox for every ad.* call. `op` is the method name, e.g. search or modify. */
export type BindingHandler = (op: string, args: unknown[]) => Promise<unknown>;

export const DEFAULT_LIMITS: Required<RunLimits> = {
  timeoutMs: 60_000,
  maxLogLines: 200,
  maxLogChars: 20_000,
};

export interface Sandbox {
  /** A sandbox with no network has nothing to hand calls to, so the handler is optional. */
  run(code: string, handler?: BindingHandler): Promise<RunResult>;
  dispose(): Promise<void>;
}
