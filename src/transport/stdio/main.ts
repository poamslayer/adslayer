import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "../../core/config.js";
import { ConnectionStore } from "../../core/connections/store.js";
import { createServer } from "../../core/server.js";
import { MiniflareSandbox } from "./miniflare-sandbox.js";
import { PowerShellHelper } from "./powershell-helper.js";

export async function buildDeps() {
  const config = resolveConfig();
  const store = new ConnectionStore(config.connectionsFile);
  // The runtime is started on the first run, so the CLI commands never spawn workerd.
  const sandbox = new MiniflareSandbox();
  // Started on the first ad.* call and kept running, so its LDAP connections stay open. ADR-0003.
  const backend = new PowerShellHelper();
  // The second sandbox, for catalogue scripts. Built without the AD service binding, so it has no
  // network at all, and only on the first search, so a server that never searches never pays for it.
  let builtCatalogueSandbox: MiniflareSandbox | undefined;
  const catalogueSandbox = { run: (code: string) => (builtCatalogueSandbox ??= new MiniflareSandbox({ adServiceBinding: false })).run(code) };
  const dispose = async () => {
    await Promise.all([sandbox.dispose(), builtCatalogueSandbox?.dispose(), backend.dispose()]);
  };
  return { config, store, sandbox, catalogueSandbox, backend, dispose };
}

export async function startStdioServer(): Promise<void> {
  const deps = await buildDeps();
  const server = createServer(deps);
  const transport = new StdioServerTransport();

  // Called from several places that can race: two signals, or a signal arriving while stdin is
  // closing. Disposing twice is harmless but exiting twice is not, so the first caller wins.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void deps.dispose().finally(() => process.exit(0));
  };

  transport.onclose = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // `StdioServerTransport.start` listens for `data` and `error` on stdin and nothing else, so end
  // of input never reaches `transport.onclose`. Without these, a client that closes the pipe
  // leaves this process and its workerd child running. Found in graphslayer.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(transport);
  // Never write to stdout here. Stdout is the MCP channel.
  process.stderr.write(`adslayer ready. Home: ${deps.config.homeDir}\n`);
}
