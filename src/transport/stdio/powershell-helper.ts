import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { LdapError, type LdapBackend } from "../../core/ldap/backend.js";

/** The same path from src/transport/stdio and from dist/transport/stdio. npm ships the file. */
export const HELPER_SCRIPT = fileURLToPath(new URL("../../../helper/adslayer-helper.ps1", import.meta.url));

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface PowerShellHelperOptions {
  /** The program and arguments that start the helper. Tests pass a fake that speaks the protocol. */
  command?: { file: string; args: string[] };
  requestTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

/**
 * PowerShell 7 when it is installed, Windows PowerShell 5.1 when it is not (ADR-0003).
 * ADSLAYER_POWERSHELL names a specific one.
 */
export function helperCommand(env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  const pwsh7 = path.join(env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  const file = env.ADSLAYER_POWERSHELL ?? (existsSync(pwsh7) ? pwsh7 : "powershell.exe");
  return { file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER_SCRIPT] };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Runs the PowerShell helper (ADR-0003) and speaks its JSON-lines protocol: one request per line on
 * stdin, one answer per line on stdout, matched by id. The helper is started on the first call and
 * kept running, so its LDAP connections stay open between calls. If it exits, every call waiting on
 * it fails and the next call starts a new one.
 */
export class PowerShellHelper implements LdapBackend {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = "";
  private readonly requestTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly command: { file: string; args: string[] } | undefined;

  constructor(options: PowerShellHelperOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.command = options.command;
  }

  async call(domain: string, op: string, args: Record<string, unknown>): Promise<unknown> {
    // ADR-0002. A fake command is how tests run elsewhere; the real helper needs Windows.
    if (!this.command && this.platform !== "win32") {
      throw new LdapError("NotWindows", "adslayer reaches Active Directory only from a Windows machine joined to the domain, as the logged-on user.");
    }
    const child = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The LDAP helper did not answer ${op} within ${this.requestTimeoutMs / 1000} seconds, so it was restarted.`));
        // The helper answers in order, so one stuck request blocks every later one. Start over.
        this.stop();
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, op, args: { domain, ...args } }) + "\n");
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const { file, args } = this.command ?? helperCommand();
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.stderrTail = "";

    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      // Kept for the message when the helper dies, and passed on so a person can see it.
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
      process.stderr.write(chunk);
    });
    // Covers both a helper that crashes and one that never started, e.g. powershell.exe missing.
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      const tail = this.stderrTail.trim();
      this.failAll(new Error(`The LDAP helper ${why}.${tail ? ` Its last output: ${tail}` : ""}`));
    };
    child.on("error", (err) => gone(`could not start (${err.message})`));
    child.on("exit", (code, signal) => gone(`exited (${signal ?? `code ${code}`})`));
    return child;
  }

  private onLine(line: string): void {
    let msg: { id?: number | null; ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`adslayer: ignored a line from the LDAP helper that is not JSON: ${line.slice(0, 200)}\n`);
      return;
    }
    const pending = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!pending) return;
    this.pending.delete(msg.id as number);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.value ?? null);
    else pending.reject(new LdapError(msg.error?.code ?? "HelperError", msg.error?.message ?? "The LDAP helper reported an error with no message."));
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    this.failAll(new Error("The LDAP helper was stopped."));
    if (child && child.exitCode === null) child.kill();
  }

  /** Closes stdin, which ends the helper's read loop so it disposes its connections, then makes sure. */
  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.failAll(new Error("The server is shutting down."));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  }
}
