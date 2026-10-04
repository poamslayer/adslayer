import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CatalogueCache } from "../catalogue/catalogue.js";
import type { ConnectionStore } from "../connections/store.js";
import type { LdapBackend } from "../ldap/backend.js";
import { BINDING_TYPES } from "../sandbox/binding-types.js";
import { makeBinding } from "../sandbox/binding.js";
import type { RunResult, Sandbox } from "../sandbox/sandbox.js";
import type { AdCallRecord } from "../types.js";
import { DEFAULT_MAX_CHARS, capJson, shedToFit } from "./output.js";

export const EXECUTE_DESCRIPTION = `Run a JavaScript script against one Active Directory domain. Use this for any read, filter, join, count, or change. Write the body of an async function and "return" the value you want back. Only what you return (and console.log) comes back to you, so filter and pick attributes inside the script. Output is capped at about 10,000 tokens.

Every call runs as the Windows user the server runs as, over Kerberos with signing and sealing, against the domain's PDC emulator, so Active Directory's own permissions decide what succeeds. Use connections_list to find domain aliases. Name objects by DN. Pass your own attributes; without them you get name, objectClass and sAMAccountName. A connection added in read mode refuses add, modify, delete, move, addAce and removeAce.

Available in the script:
${BINDING_TYPES}

Examples:
// Enabled users in an OU, by name
const r = await ad.search({ base: "OU=Sales,DC=contoso,DC=local", filter: "(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))", attributes: ["sAMAccountName"] });
return r.entries.map(e => e.attributes.sAMAccountName[0]);

// How many members a group has, nested groups not expanded
const g = await ad.get("CN=Helpdesk,OU=Groups,DC=contoso,DC=local", ["member"]);
return g?.attributes.member?.length ?? 0;

// Disable a user (514 = normal account + disabled)
return await ad.modify("CN=Jane Doe,OU=Sales,DC=contoso,DC=local", [{ op: "replace", attribute: "userAccountControl", values: "514" }]);

// Reset a password. unicodePwd takes the password in double quotes as UTF-16LE bytes. Add pwdLastSet "0" to force a change at next sign-in.
const pw = '"' + newPassword + '"';
let b = "";
for (let i = 0; i < pw.length; i++) { const c = pw.charCodeAt(i); b += String.fromCharCode(c & 255, c >> 8); }
return await ad.modify("CN=Jane Doe,OU=Sales,DC=contoso,DC=local", [{ op: "replace", attribute: "unicodePwd", values: { base64: btoa(b) } }, { op: "replace", attribute: "pwdLastSet", values: "0" }]);

// Restore a deleted user from the Recycle Bin to where it was. Delete isDeleted first, then set the new DN.
const controls = { showDeleted: true };
const gone = (await ad.search({ base: "CN=Deleted Objects,DC=contoso,DC=local", filter: "(&(isDeleted=TRUE)(sAMAccountName=jdoe))", attributes: ["lastKnownParent", "msDS-LastKnownRDN"], controls })).entries[0];
const to = "CN=" + gone.attributes["msDS-LastKnownRDN"][0] + "," + gone.attributes.lastKnownParent[0];
return await ad.modify(gone.dn, [{ op: "delete", attribute: "isDeleted" }, { op: "replace", attribute: "distinguishedName", values: to }], { controls });

// Who can reset passwords in an OU: full control, all extended rights, or the Reset Password right
const acl = await ad.getAcl("OU=Sales,DC=contoso,DC=local");
return acl.aces.filter(a => a.type === "allow" && (a.rights.includes("GenericAll") || (a.rights.includes("ExtendedRight") && (!a.objectType || a.objectType === "User-Force-Change-Password")))).map(a => a.principal.name ?? a.principal.sid);

// Password and lockout policy for the domain, from the Default Domain Policy's security settings
const sa = (await gpo.get("Default Domain Policy")).securitySettings.systemAccess;
return { minLength: sa.MinimumPasswordLength, lockoutAfter: sa.LockoutBadCount };

// Let a service account log on as a service through a GPO. If the GPO doesn't define the right yet, granting
// defines it with only this account on every computer it applies to, so read who holds it first.
const before = (await gpo.get("Web Servers")).securitySettings.privilegeRights.SeServiceLogonRight;
return await gpo.grant("Web Servers", "SeServiceLogonRight", "CONTOSO\\svc-web");   // { changed, defined, before, after }

// Protect an OU from accidental deletion, as the admin tools do. AD allows a delete with Delete on the object or
// DeleteChild on its parent, so deny both. To undo, removeAce the first; the parent's deny also protects its other children.
await ad.addAce("OU=Sales,DC=contoso,DC=local", { principal: "S-1-1-0", type: "deny", rights: ["Delete", "DeleteTree"] });
return await ad.addAce("DC=contoso,DC=local", { principal: "S-1-1-0", type: "deny", rights: ["DeleteChild"] });`;

export interface ExecuteDeps {
  store: Pick<ConnectionStore, "resolve">;
  backend: LdapBackend;
  sandbox: Pick<Sandbox, "run">;
  /** Names the GUIDs in an ACL. Shared with search, so a domain's schema is read once. */
  catalogues?: Pick<CatalogueCache, "get">;
}

const outputSchema = {
  ok: z.boolean(),
  domain: z.string(),
  result: z.unknown().optional(),
  error: z.object({ name: z.string(), message: z.string(), line: z.number().optional() }).optional(),
  logs: z.array(z.string()),
  calls: z.array(z.object({ op: z.string(), target: z.string(), ok: z.boolean(), code: z.string().optional(), ms: z.number() })),
  truncated: z.boolean(),
};

export const TRUNCATION_NOTE =
  "Output was truncated. Ask for fewer attributes, narrow the filter, or return fewer items.";

export interface RunOutput {
  // The MCP SDK types structured content as an open record.
  [key: string]: unknown;
  ok: boolean;
  domain: string;
  result?: unknown;
  error?: { name: string; message: string; line?: number };
  logs: string[];
  calls: AdCallRecord[];
  truncated: boolean;
}

/**
 * Shapes one run into the tool result, keeping the whole payload inside the cap.
 * The result, the logged lines, and the call records all cost the model tokens, so
 * measuring only the result would let the other two push the payload over the cap
 * while `truncated` still said false. Shed in order of what the model can most
 * afford to lose, and report `truncated` for whatever was actually cut.
 */
export function shapeRunOutput(
  run: RunResult,
  domain: string,
  calls: AdCallRecord[],
  maxChars: number = DEFAULT_MAX_CHARS,
): RunOutput {
  const cappedResult = capJson(run.data, maxChars);
  const error = run.error
    ? { name: run.error.name, message: run.error.message, ...(run.error.line !== undefined ? { line: run.error.line } : {}) }
    : undefined;
  const base = {
    ok: run.ok,
    domain,
    result: run.ok ? (cappedResult.truncated ? cappedResult.text : run.data) : undefined,
    error,
  };

  return shedToFit<RunOutput>(
    [
      { ...base, logs: run.logs, calls, truncated: cappedResult.truncated },
      // The logged lines are the cheapest thing to lose, then the per-call records.
      { ...base, logs: [], calls, truncated: true },
      { ...base, logs: [], calls: [], truncated: true },
      // Still over: the result alone is too big, so cut it harder and keep the shape.
      {
        ...base,
        result: run.ok ? capJson(run.data, Math.floor(maxChars / 2)).text : undefined,
        logs: [],
        calls: [],
        truncated: true,
      },
    ],
    maxChars,
  );
}

export function registerExecuteTool(server: McpServer, deps: ExecuteDeps): void {
  server.registerTool(
    "execute",
    {
      title: "Run an Active Directory script",
      description: EXECUTE_DESCRIPTION,
      inputSchema: {
        domain: z.string().describe("Connection alias or the domain's DNS name. See connections_list."),
        code: z.string().describe("Body of an async JavaScript function. Use await ad.* and return a value."),
      },
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ domain, code }) => {
      const connection = await deps.store.resolve(domain);
      if (!connection) {
        return {
          isError: true,
          content: [{ type: "text", text: `No connection named "${domain}". Call connections_list to see aliases, or connection_add to add the domain.` }],
        };
      }
      const { handle, calls } = makeBinding({ backend: deps.backend, connection, catalogues: deps.catalogues });
      const run = await deps.sandbox.run(code, handle);
      const structured = shapeRunOutput(run, connection.domain, calls());
      const text = structured.truncated
        ? `${capJson(structured).text}\n\n${TRUNCATION_NOTE}`
        : capJson(structured).text;
      return { content: [{ type: "text", text }], structuredContent: structured };
    },
  );
}
