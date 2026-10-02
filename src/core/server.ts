import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CatalogueCache } from "./catalogue/catalogue.js";
import type { ConnectionStore } from "./connections/store.js";
import type { LdapBackend } from "./ldap/backend.js";
import type { Sandbox } from "./sandbox/sandbox.js";
import { registerConnectionTools } from "./tools/connections.js";
import { registerDocsTool, type DocsDeps } from "./tools/docs.js";
import { registerExecuteTool } from "./tools/execute.js";
import { registerSearchTool } from "./tools/search.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export interface ServerDeps extends DocsDeps {
  store: ConnectionStore;
  backend: LdapBackend;
  sandbox: Pick<Sandbox, "run">;
  /** A sandbox with no network, for catalogue scripts. ADR-0010. */
  catalogueSandbox: Pick<Sandbox, "run">;
  catalogues?: Pick<CatalogueCache, "get">;
}

export { SERVER_NAME, SERVER_VERSION } from "./version.js";

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerSearchTool(server, { store: deps.store, catalogues: deps.catalogues ?? new CatalogueCache(deps.backend), catalogueSandbox: deps.catalogueSandbox });
  // MCP clients cache the tool list, so connection changes must never make a tool appear or
  // disappear during a session. A read connection still gets execute; it refuses writes itself.
  registerExecuteTool(server, deps);
  registerDocsTool(server, deps);
  registerConnectionTools(server, deps);
  return server;
}
