import { existsSync } from "node:fs";
import path from "node:path";
import { Miniflare, NoOpLog, Response as MfResponse, type Request as MfRequest } from "miniflare";
import {
  DEFAULT_LIMITS,
  type BindingHandler,
  type RunLimits,
  type RunResult,
  type Sandbox,
} from "../../core/sandbox/sandbox.js";
import { HOST_WORKER_SOURCE, scriptLineOffset } from "../../core/sandbox/sandbox-worker.js";

const BINDING_HOST = "ad.local";

/** Served to anything that reaches the host worker's own outbound. Nothing should. */
export const NO_OUTBOUND = "The host worker has no outbound.";

export interface MiniflareSandboxOptions extends RunLimits {
  /**
   * Whether the sandbox is built with the AD service binding, the workerd binding that carries a
   * run's ad.* calls out to Node. Without it the sandbox has no network at all: not the binding
   * host, not any other host, and no argument to `run` can turn it back on.
   */
  adServiceBinding?: boolean;
  /**
   * JavaScript placed in front of every script the sandbox runs, so a caller does not have to
   * remember to prepend it. It runs at module scope, so what it declares the script can read.
   */
  preamble?: string;
}

export class MiniflareSandbox implements Sandbox {
  private mf: Miniflare | undefined;
  private readonly handlers = new Map<string, BindingHandler>();
  private readonly limits: Required<RunLimits>;
  private readonly adServiceBinding: boolean;
  private readonly preamble: string;

  constructor(options: MiniflareSandboxOptions = {}) {
    const { adServiceBinding = true, preamble = "", ...limits } = options;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.adServiceBinding = adServiceBinding;
    this.preamble = preamble;
  }

  /** Starts workerd on first use. Nothing is spawned until the first run. */
  private instance(): Miniflare {
    this.mf ??= new Miniflare({
      modules: true,
      compatibilityDate: "2026-01-12",
      script: HOST_WORKER_SOURCE,
      workerLoaders: { LOADER: {} },
      // Omitting AD leaves `env.AD` undefined, which the host worker turns into an explicit null
      // outbound. The sandbox then has no network.
      ...(this.adServiceBinding
        ? { serviceBindings: { AD: (request: MfRequest) => this.dispatch(request) } }
        : {}),
      bindings: { PREAMBLE: this.preamble },
      // The host worker needs no outbound of its own, and refusing one here means a sandbox
      // that ever did inherit the parent's outbound would land on this rather than the internet.
      outboundService: () => new MfResponse(NO_OUTBOUND, { status: 403 }),
      log: new NoOpLog(),
    });
    return this.mf;
  }

  /** Every fetch from every isolate lands here. Only ad.local with a known run id is served. */
  private async dispatch(request: MfRequest): Promise<MfResponse> {
    const url = new URL(request.url);
    const handler = this.handlers.get(request.headers.get("x-run-id") ?? "");
    if (url.hostname !== BINDING_HOST || !handler) {
      return new MfResponse(`Forbidden: ${url.hostname}`, { status: 403 });
    }
    const { op, args } = (await request.json()) as { op: string; args: unknown[] };
    try {
      // JSON turns a missing argument into null. Give the handler undefined instead.
      const value = await handler(op, (args ?? []).map((a) => (a === null ? undefined : a)));
      return json({ ok: true, value: value === undefined ? null : value });
    } catch (err) {
      return json({ ok: false, message: (err as Error).message });
    }
  }

  async run(code: string, handler?: BindingHandler): Promise<RunResult> {
    const runId = crypto.randomUUID();
    if (handler) this.handlers.set(runId, handler);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.limits.timeoutMs);
    try {
      const res = await this.instance().dispatchFetch("http://sandbox.local/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, runId, maxLogLines: this.limits.maxLogLines, maxLogChars: this.limits.maxLogChars }),
        signal: ac.signal,
      });
      return withScriptLine((await res.json()) as RunResult, scriptLineOffset(this.preamble));
    } catch (err) {
      if (ac.signal.aborted) {
        // Local workerd has no CPU limit. A runaway script wedges it, so throw the runtime away.
        await this.reset();
        return {
          ok: false,
          error: { name: "TimeoutError", message: `Script exceeded ${this.limits.timeoutMs} ms and was stopped. Fetch fewer items or narrow the query.` },
          logs: [],
        };
      }
      const hint = workerdStartHint();
      return { ok: false, error: { name: "SandboxError", message: hint ? `${hint} (${(err as Error).message})` : (err as Error).message }, logs: [] };
    } finally {
      clearTimeout(timer);
      this.handlers.delete(runId);
    }
  }

  /** Throws the runtime away. The next run starts a fresh one in about thirty milliseconds. */
  private async reset(): Promise<void> {
    const mf = this.mf;
    this.mf = undefined;
    await mf?.dispose();
  }

  async dispose(): Promise<void> {
    await this.reset();
  }
}

export const VC_RUNTIME_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";

/**
 * Why workerd cannot start, when the reason is one we know. Windows Server ships without the
 * Visual C++ runtime workerd links against, and workerd then exits with 0xC0000135 before it reads
 * a byte, which reaches us only as "write EOF". Found on the lab DC (adslayer #6).
 */
export function workerdStartHint(
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
  systemRoot: string = process.env.SystemRoot ?? "C:\\Windows",
): string | undefined {
  if (platform !== "win32") return undefined;
  if (exists(path.win32.join(systemRoot, "System32", "vcruntime140_1.dll"))) return undefined;
  return `The script sandbox (workerd) cannot start because the Microsoft Visual C++ Redistributable (x64) is not installed. Install it from ${VC_RUNTIME_URL} and run the script again.`;
}

/**
 * The sandbox module wraps the script, so a stack frame points at a line in the wrapper.
 * Translate the first frame back to the script's own line so the model can find the fault.
 */
function withScriptLine(result: RunResult, offset: number): RunResult {
  const stack = result.error?.stack;
  if (!result.error || !stack) return result;
  const match = /sandbox\.js:(\d+):/.exec(stack);
  if (!match) return result;
  const line = Number(match[1]) - offset;
  if (!Number.isFinite(line) || line < 1) return result;
  return { ...result, error: { ...result.error, line } };
}

function json(body: unknown): MfResponse {
  return new MfResponse(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
