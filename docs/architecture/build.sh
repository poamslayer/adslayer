#!/bin/sh
# Builds the map as a static site under /architecture/, the map's place in the adslayer docs at
# adslayer.poamslayer.com. Cloudflare Workers Builds runs this from docs/architecture.
# Hash history (/architecture/#/view/...) means no server-side routing is needed.
set -e
rm -rf dist
npx -y likec4@1.59 build -o dist/architecture --base /architecture/ --use-hash-history --title "adslayer map" .
# Until the docs site exists, the bare host goes to the map. 302, not 301, so browsers don't
# remember it once the docs site takes over /.
printf '/ /architecture/ 302\n' > dist/_redirects
