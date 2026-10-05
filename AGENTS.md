## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues (`poamslayer/adslayer`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Architecture map

`docs/architecture/adslayer.c4` is the LikeC4 map of record, following the `diagrams` skill. Update it in the same change when you add, remove, rename or rewire anything under `src/` or `helper/`, add an MCP tool, or add an outside system the server talks to. `test/architecture-map.test.ts` fails when a module has no element. Check it with `npx -y likec4@1.59 validate docs/architecture`. Cloudflare Workers Builds publishes it to https://adslayer.poamslayer.com/architecture/ whenever it changes on `main`, using `docs/architecture/build.sh` and `wrangler.jsonc`. poamslayer.com has a redirect rule that sends every host to arnolddelavega.com except the ones it lists; `adslayer.poamslayer.com` must stay on that list.
