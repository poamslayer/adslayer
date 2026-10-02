#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { modeOf, type ConnectionStore } from "../core/connections/store.js";
import { DOMAIN_NAME_RE } from "../core/tools/connections.js";
import type { ConnectionMode } from "../core/types.js";
import { buildDeps, startStdioServer } from "../transport/stdio/main.js";

export type CliArgs =
  | { command: "serve" }
  | { command: "help" }
  | { command: "connections" }
  | { command: "connect"; domain: string; alias?: string; mode: ConnectionMode }
  | { command: "disconnect"; alias: string };

export function parseArgs(argv: string[]): CliArgs {
  const [cmd, ...rest] = argv;
  if (!cmd) return { command: "serve" };
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return { command: "help" };
  if (cmd === "connections") return { command: "connections" };
  if (cmd === "connect") return parseConnect(rest);
  if (cmd === "disconnect") {
    if (!rest[0]) throw new Error("disconnect needs an alias");
    return { command: "disconnect", alias: rest[0] };
  }
  throw new Error(`Unknown command "${cmd}". Run with --help.`);
}

function parseConnect(rest: string[]): CliArgs {
  let domain: string | undefined;
  let alias: string | undefined;
  let mode: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!flag.startsWith("--")) {
      if (domain !== undefined) throw new Error(`Unexpected argument "${flag}"`);
      domain = flag;
      continue;
    }
    i += 1;
    const value = rest[i];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--alias") alias = value;
    else if (flag === "--mode") mode = value;
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!domain) throw new Error("connect needs a domain, e.g. adslayer connect contoso.local");
  if (!DOMAIN_NAME_RE.test(domain)) throw new Error(`"${domain}" is not a domain's DNS name, e.g. contoso.local`);
  if (mode !== undefined && mode !== "read" && mode !== "write") throw new Error("--mode must be read or write");
  return { command: "connect", domain: domain.toLowerCase(), ...(alias ? { alias } : {}), mode: (mode as ConnectionMode | undefined) ?? "read" };
}

export async function connect(
  store: Pick<ConnectionStore, "upsert">,
  args: Extract<CliArgs, { command: "connect" }>,
  now: () => Date = () => new Date(),
): Promise<string> {
  const connection = { alias: args.alias ?? args.domain, domain: args.domain, mode: args.mode, addedAt: now().toISOString() };
  await store.upsert(connection);
  return `Added "${connection.alias}" (${connection.domain}), mode ${modeOf(connection)}. Calls run as the Windows user running adslayer.\n`;
}

const HELP = `adslayer

  adslayer                     Start the MCP server on stdio (what your MCP client runs)
  adslayer connect <domain>    Add a domain by its DNS name, e.g. contoso.local. No sign-in:
                               every call runs as the Windows user running adslayer.
      --alias <name>           Short name for the connection (default: the domain name)
      --mode read|write        Whether execute may write through it (default: read)
  adslayer disconnect <alias>  Remove a stored connection
  adslayer connections         List stored connections
`;

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "serve") return startStdioServer();
  if (args.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const deps = await buildDeps();
  if (args.command === "connections") {
    for (const c of await deps.store.list()) process.stdout.write(`${c.alias}\t${c.domain}\t${modeOf(c)}\n`);
    return;
  }
  if (args.command === "disconnect") {
    const removed = await deps.store.remove(args.alias);
    process.stdout.write(removed ? `Removed "${args.alias}".\n` : `No connection named "${args.alias}".\n`);
    return;
  }
  process.stdout.write(await connect(deps.store, args));
}

/**
 * Whether this module is the program being run. npm and npx start the bin through a symlink in
 * node_modules/.bin, so the path in argv names the link while import.meta.url names the file it
 * points to. Both are resolved before comparing. Found in graphslayer (#63 there).
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  const real = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
