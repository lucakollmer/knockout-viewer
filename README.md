# Knockout Viewer

Public browser implementation of the canonical group enumeration and interactive A-set computation used by the Knockout A-sets project.

The current application provides:

- lazy, client-side enumeration of canonical effective cyclic SL three-block presentations;
- dimension and modulus navigation with a virtualized MUI Data Grid;
- direct group selection with canonicalization and effective reduction;
- interactive A-set enumeration in Web Workers, with deterministic parallel execution for measured hard families;
- exact transition-row/coherence geometry for emitted A-sets;
- IndexedDB caching of completed A-set families;
- benchmark pages and a Cloudflare KV relay used for controlled browser performance validation.

## A-set algorithm

The production algorithm is documented in [`docs/ASETS_ALGORITHM.md`](docs/ASETS_ALGORITHM.md).

The release implementation intentionally contains only mechanisms that survived correctness and same-machine performance testing. Rejected experiments such as eight-worker scheduling, larger cache chunks, incremental CSP domain bookkeeping, standalone weighted root splitting, and the geometry point-state cache are not part of the release runtime.

## Exactness gates

Group enumeration follows the settled global C-first convention. `tests/fixtures/current-universe-d3-12-r2-50.json` contains `(d,r)` row counts plus a global SHA-256 digest derived from the authoritative SQLite `groups` table. The test suite re-enumerates all 73,571 settled rows for `d=3..12`, `r=2..50`, checks every batch count, and requires the complete canonical row stream and ordering to match the authoritative digest.

The interactive A-set path has independent exactness checks. The optimized enumerator is compared with settled oracle data, frozen family digests, reference geometry, and deterministic partition-concatenation tests. In particular, concatenating worker partitions must reproduce the exact single-thread emission order.

## Development

```bash
npm install
npm run build
npm run dev
```

`npm run build` runs the test suite and TypeScript checking before Vite. On Cloudflare Workers Builds it also writes `/deployment.json` using Cloudflare's `WORKERS_CI_COMMIT_SHA`, branch and build UUID so an exact deployed commit can be verified after publication.

## Cloudflare

The Cloudflare Worker serves the SPA assets and the benchmark ingest/readback endpoints. `wrangler.jsonc` binds the shared `BENCHMARKS` KV namespace and enables immutable preview URLs for review builds.

Workers Builds use the repository's configured build/deploy commands. Production traffic is associated with `main`; non-main branches publish immutable review versions. GitHub Actions are not part of this project's validation/deployment workflow.
