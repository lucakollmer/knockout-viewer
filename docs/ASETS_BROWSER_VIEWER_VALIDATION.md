# Browser Asets viewer validation

This tranche connects the optimized browser Asets engine to the prior human-facing Asets viewer without shipping the generalized-v5 SQLite database to the browser.

## Visual reference

The accepted visual/interaction reference was supplied as:

- package: `asets_v0.3.10_generalized_effective_cfirst_global_full.zip`
- package SHA-256: `2588df33ccfe2fd407d6c8a16bb3216c6987143646a3780e2626123938e51b7a`
- viewer version: `v0.3.10-generalized-effective-cfirst-global`

The embedded browser asset retains the old viewer's three inspection surfaces:

1. junior-simplex radial projection;
2. rotatable raw 3D cone complex with transparent A-set polygons;
3. collapsed monomial A-set selector with ages/coordinates/colour toggles.

The old database browser/query header is hidden in embedded mode because group selection now comes from the Knockout viewer's browser-native canonical group navigator.

## Data-source substitution

The old viewer materialised its display payload from SQLite. The production browser path now builds the same display contract from the TypeScript worker result:

- formal C/D/E intercepts are `r/n`, `r/m`, `r/k`;
- canonical family records are transported back to the selected C/D/E presentation by the exact family transform certificate;
- each A-set polygon is reconstructed from inactive-axis intercepts plus quotient-lattice low rays;
- the original cyclic polygon ordering algorithm is retained for quadrilaterals;
- the union of polygon edges reconstructs the old adjacency graph;
- the generated downset itself feeds the collapsed monomial A-set panel.

No SQLite family/group payload is required at runtime.

## Reference-adapter regression

The TypeScript adapter was compared against the supplied v0.3.10 Python viewer using the authoritative generalized-v5 SQLite package. Representative groups spanning identity and nontrivial family-to-group axis transports were checked:

`1, 402, 405, 406, 421, 5000, 30000, 73571`.

For each checked group the generated adapter agreed with the old viewer on:

- terminal A-set count;
- complete display point set;
- undirected adjacency-edge count;
- surface-polygon count;
- presentation-transformed collapsed monomial A-sets and coherence flags.

Examples pinned in `tests/asetsLegacyAdapter.test.ts` include the d=4/r=2 reference geometry, a nontrivial axis permutation, and a repeated-residue five-cone case.

## Worker/cache behavior for visualization

`AsetsComputeRequest.includeRecords` is optional. Header-only consumers can preserve the optimized completed-header cache hit. The visualizer requests records explicitly:

- cold computation posts the same 64-record chunks that are already retained for the atomic IndexedDB family write;
- a completed-family cache hit reads those stored chunks in one readonly transaction and streams them to the UI;
- equivalent group presentations continue to share the canonical family cache while receiving the request-specific transform certificate;
- no cross-family geometry/search cache is introduced.

## Chromium visual smoke

A headless Chromium smoke test executed the optimized packed CSP + family-local geometry worker and sent its generated records through the adapter into the embedded v0.3.10 viewer. The junior-simplex, 3D cone, and monomial panels all rendered from generated data. The managed browser permits only an opaque `about:blank` origin, so this smoke test intentionally did not claim real IndexedDB latency. Normal-HTTPS cache timing remains a manual/product-browser measurement.

## Promotion boundary

This integration does not advance `main`. The draft candidate still requires normal-HTTPS manual review of group-click generation, cached revisits/equivalent presentations, rapid navigation/cancellation, practical memory, and visual parity before merge.
