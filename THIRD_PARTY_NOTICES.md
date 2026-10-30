# Third-Party Notices

This repository includes or depends on the third-party components listed
below. Full license texts are in `LICENSES/`, except where a component ships
its own license file.

## Chart.js

- Vendored version: 4.4.7
- Declared dependency: `chart.js` `^4.4.0` in `frontend/mobile/package.json`
  (the lockfile resolves to 4.5.1)
- License: MIT
- Copyright: 2014-2024 Chart.js Contributors
- Vendored path: `desktop/pc-sensor/static/vendor/chart.umd.min.js`
- License text: `desktop/pc-sensor/static/vendor/LICENSE.md` and
  `LICENSES/MIT.txt`

## lz-string

- Declared dependency: 1.5.0 in `frontend/mobile/package-lock.json`
- License: MIT
- Copyright: 2013 Pieroxy
- Bundled copy: shipped inside the independent `kinship-circuitjs` repository
  at `circuitjs1/lz-string.min.js` (the minified file does not embed a version
  string). It is fetched at dev/build time and is not vendored in this public
  tree.
- License text: `LICENSES/MIT.txt`

## harness-pi

- Version: 0.5.0
- License: MIT
- Copyright: 2026 chasey-myagi
- Status: vendored into the Loom packages
- Notice: see `loom-harness/NOTICE`

## CircuitJS1

- License: GPL-2.0
- Upstream: CircuitJS1 by Paul Falstad and contributors
  (https://github.com/sharpie7/circuitjs1)
- Status: moved out of this repository to the independent GPL-2.0
  `Xehuri/kinship-circuitjs` repository. It is not vendored in the public tree.
  `frontend/mobile/scripts/fetch-circuitjs.mjs` copies tag `v0.1.1` into
  `frontend/mobile/public/circuitjs1/` and verifies it against the repository
  `MANIFEST.sha256`. The script runs before `npm run dev`, `npm run build`,
  `npm run build:e2e`, and `npm run build:atomic`; that directory is
  gitignored. It can also be run directly with `npm run fetch:circuitjs`.
- Status: published at `https://github.com/Xehuri/kinship-circuitjs` (GPL-2.0).
  `frontend/mobile/scripts/fetch-circuitjs.mjs` clones tag `v0.1.1` into
  `frontend/mobile/public/circuitjs1/` and verifies it against the repository
  `MANIFEST.sha256`. The script runs before `npm run dev`, `npm run build`,
  `npm run build:e2e`, and `npm run build:atomic`; that directory is
  gitignored. It can also be run directly with `npm run fetch:circuitjs`.
  Offline builds can set `CIRCUITJS_LOCAL_DIR=/path/to/kinship-circuitjs`.
- Obligation: anyone distributing CircuitJS1 or a modified version must keep
  the GPL-2.0 terms, preserve copyright notices, and provide the corresponding
  source as required by GPL-2.0. CircuitJS1 is not covered by the repository
  root AGPL-3.0-only license.
- License text: `LICENSES/GPL-2.0.txt`
