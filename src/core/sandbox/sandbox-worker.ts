/**
 * Source of the host worker that runs inside workerd. It receives { code, runId, maxLogLines, maxLogChars },
 * creates a fresh isolate through the Worker Loader, and returns the isolate's result as JSON.
 * Written without template literals so nothing in it is interpolated by TypeScript.
 */
export const HOST_WORKER_SOURCE = [
  "export default {",
  "  async fetch(request, env) {",
  "    const { code, runId, maxLogLines, maxLogChars } = await request.json();",
  // The preamble is a binding, not a field of the request, so it is fixed when the sandbox
  // is built rather than chosen per run.
  '    const preamble = env.PREAMBLE || "";',
  "    let out;",
  "    try {",
  '      const worker = env.LOADER.get("run-" + runId, () => ({',
  '        compatibilityDate: "2026-01-12",',
  // `?? null` is load-bearing. The Worker Loader reads an undefined outbound as "inherit the
  // parent's outbound", so a bare `env.AD` would hand a sandbox built without the service
  // binding the real internet. Only an explicit null means no network.
  "        globalOutbound: env.AD ?? null,",
  '        mainModule: "sandbox.js",',
  '        modules: { "sandbox.js": sandboxModule(code, runId, maxLogLines, maxLogChars, preamble) },',
  "      }));",
  "      out = await worker.getEntrypoint().evaluate();",
  "    } catch (e) {",
  '      out = { ok: false, error: { name: (e && e.name) || "Error", message: (e && e.message) || String(e) }, logs: [] };',
  "    }",
  '    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });',
  "  },",
  "};",
  "",
  "function sandboxModule(code, runId, maxLogLines, maxLogChars, preamble) {",
  "  return [",
  "    'import { WorkerEntrypoint } from \"cloudflare:workers\";',",
  "    'const __runId = ' + JSON.stringify(String(runId)) + ';',",
  "    'const __maxLines = ' + Number(maxLogLines) + ';',",
  "    'const __maxChars = ' + Number(maxLogChars) + ';',",
  "    'const __logs = [];',",
  "    'let __logChars = 0;',",
  "    'function __fmt(args) { return args.map(function (a) { if (typeof a === \"string\") return a; try { const s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch (e) { return String(a); } }).join(\" \"); }',",
  "    'function __log() {',",
  "    '  const args = Array.prototype.slice.call(arguments);',",
  "    '  if (__logs.length >= __maxLines) return;',",
  "    '  const line = __fmt(args);',",
  "    '  if (__logChars + line.length > __maxChars) { if (__logChars <= __maxChars) { __logs.push(\"[log output truncated]\"); __logChars = __maxChars + 1; } return; }',",
  "    '  __logs.push(line); __logChars += line.length;',",
  "    '}',",
  "    'const console = { log: __log, info: __log, warn: __log, error: __log, debug: __log };',",
  "    'async function __call(op, args) {',",
  "    '  const r = await fetch(\"https://ad.local/\" + op, { method: \"POST\", headers: { \"content-type\": \"application/json\", \"x-run-id\": __runId }, body: JSON.stringify({ op: op, args: args }) });',",
  "    '  const body = await r.json();',",
  "    '  if (!body.ok) throw new Error(body.message);',",
  "    '  return body.value;',",
  "    '}',",
  "    'const ad = {',",
  "    '  get: function (dn, attributes) { return __call(\"get\", [dn, attributes]); },',",
  "    '  search: function (opts) { return __call(\"search\", [opts]); },',",
  "    '  whoami: function () { return __call(\"whoami\", []); },',",
  "    '  add: function (dn, attributes) { return __call(\"add\", [dn, attributes]); },',",
  "    '  modify: function (dn, changes) { return __call(\"modify\", [dn, changes]); },',",
  "    '  delete: function (dn, opts) { return __call(\"delete\", [dn, opts]); },',",
  "    '  move: function (dn, to) { return __call(\"move\", [dn, to]); },',",
  "    '};',",
  "    'const gpo = {',",
  "    '  list: function () { return __call(\"gpo.list\", []); },',",
  "    '  get: function (g) { return __call(\"gpo.get\", [g]); },',",
  "    '  create: function (name, opts) { return __call(\"gpo.create\", [name, opts]); },',",
  "    '  delete: function (g) { return __call(\"gpo.delete\", [g]); },',",
  "    '  link: function (g, target, opts) { return __call(\"gpo.link\", [g, target, opts]); },',",
  "    '  unlink: function (g, target) { return __call(\"gpo.unlink\", [g, target]); },',",
  "    '  set: function (g, setting) { return __call(\"gpo.set\", [g, setting]); },',",
  "    '  remove: function (g, key, valueName) { return __call(\"gpo.remove\", [g, key, valueName]); },',",
  "    '  backup: function (g, path) { return __call(\"gpo.backup\", [g, path]); },',",
  "    '};',",
  "    preamble,",
  "    'export default class Run extends WorkerEntrypoint {',",
  "    '  async evaluate() {',",
  "    '    try {',",
  "    '      const __main = async () => {',",
  "    code,",
  "    '      };',",
  "    '      const data = await __main();',",
  "    '      return { ok: true, data: data === undefined ? null : data, logs: __logs };',",
  "    '    } catch (e) {',",
  "    '      return { ok: false, error: { name: (e && e.name) || \"Error\", message: (e && e.message) || String(e), stack: e && e.stack }, logs: __logs };',",
  "    '    }',",
  "    '  }',",
  "    '}',",
  "  ].join(\"\\n\");",
  "}",
].join("\n");

/**
 * Lines the sandbox module puts before the script when the sandbox was built without a
 * preamble, so a stack frame at `sandbox.js:N` is the script's own line
 * `N - SANDBOX_SCRIPT_LINE_OFFSET`. A preamble occupies the one line already counted here,
 * plus one for each line break it carries: see `scriptLineOffset`.
 * A test in test/transport/stdio/miniflare-sandbox.test.ts pins this, so it fails if the
 * lines the module puts above the script ever change.
 */
export const SANDBOX_SCRIPT_LINE_OFFSET = 46;

/**
 * Lines above the script for a sandbox built with this preamble. The breaks are counted rather
 * than split on, so a large one-line preamble is not copied just to learn it has no breaks.
 */
export function scriptLineOffset(preamble: string): number {
  let breaks = 0;
  for (let at = preamble.indexOf("\n"); at !== -1; at = preamble.indexOf("\n", at + 1)) breaks += 1;
  return SANDBOX_SCRIPT_LINE_OFFSET + breaks;
}
