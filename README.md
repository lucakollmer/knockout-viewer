# Knockout Viewer

Public browser implementation of the canonical group enumeration used by the Knockout A-sets project.

The first tranche provides:

- lazy, client-side enumeration of canonical effective cyclic SL three-block presentations;
- dimension and modulus navigation with a virtualized MUI Data Grid;
- direct group selection with inference of an omitted value from `d,n,m,k` and, where mathematically determined, from `r,a,b,c`;
- explicit choices when a modular congruence has several valid residues/moduli rather than pretending the missing value is unique;
- canonicalization of noncanonical and non-effective presentations;
- browser-side IndexedDB caching of generated `(d,r)` batches.

A-set calculation and geometry are deliberately not part of this tranche.

## Exactness gate

The enumerator follows the settled global C-first convention. `tests/fixtures/current-universe-d3-12-r2-50.json` contains `(d,r)` row counts plus a global SHA-256 digest derived from the authoritative SQLite `groups` table. The test suite re-enumerates all 73,571 settled rows for `d=3..12`, `r=2..50`, checks every batch count, and requires the complete canonical row stream and ordering to match the authoritative digest.

## Development

```bash
npm install
npm run build
npm run dev
```

`npm run build` runs tests and TypeScript checking before Vite. On Cloudflare Workers Builds it also writes `/deployment.json` using Cloudflare's `WORKERS_CI_COMMIT_SHA`, branch and build UUID so an exact deployed commit can be verified after publication.

## Cloudflare

The Worker is an assets-only SPA configured by `wrangler.jsonc` and served at `knockout.lucakollmer.com`.

Workers Builds should use:

- build command: `npm run build`
- production deploy command: `npx wrangler deploy`
- production branch: `main`

GitHub Actions are not part of this project's validation/deployment workflow.
