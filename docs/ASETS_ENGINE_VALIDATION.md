# Portable Asets TypeScript engine validation

This viewer port treats `portable-asets-reference-v1` as the immutable behavioral reference:

- research repository: `lucakollmer/knockout`
- frozen commit: `09da2e40f051e72a932c77df16691d0c908f3fe3`
- reference directory: `research/asets_portable`
- reference core: `research/asets_portable/core.py`
- normalized full-oracle SHA-256: `6825f6544d738f5386c5277c06da27ae3c3ebd235da1d6a5f6c811cf741f100f`
- authoritative generalized-v5 SQLite SHA-256: `a662628f57add19c75b929552684df4cf7b5dfa96de226f47e3a712f82d0e76f`

The Python reference is not modified by the browser optimization work.

## Product workload

The production workload is interactive and local-first, not bulk regeneration of the generalized-v5 database. A new browser session downloads the application and algorithm but no Aset dataset. Clicking any group must be able to compute its canonical family from scratch. Completed families are cached locally so equivalent presentations and revisits avoid recomputation.

Performance evaluation therefore prioritizes:

1. cold latency for an arbitrary uncached family;
2. cold hard-family latency;
3. same-modulus warm latency;
4. completed-family IndexedDB reuse;
5. immediate supersession while navigating rapidly;
6. exact equivalence to the frozen oracle.

No family or modulus is pre-generated on page load.

## Exactness gate

The original `src/asetsCore.ts` port passed the complete authoritative generalized-v5 differential. The final interactive path adds `src/asetsFast.ts` plus the already-validated family-local `src/asetsGeometry.ts` and has also been exhaustively revalidated.

| Measure | Result |
| --- | ---: |
| Canonical families | 12,709 / 12,709 exact |
| Representation classes represented | 73,571 |
| Terminal downsets | 483,780 / 483,780 exact |
| Noncoherent downsets | 498 |

The final packed CSP was checked against both the frozen TypeScript stream and the authoritative payload for every family. It preserves deterministic CSP emission order. The final packed-CSP + cached-geometry module sources were then checked against every authoritative record, including transition rows, coherence, exact witness, active/inactive axes, geometry shape and quotient-lattice low rays.

`tests/asetsFast.test.ts` keeps direct frozen-path sentinels, and `tests/asetsOracleV5.external.test.ts` exercises the exact optimized path when `ASETS_V5_DB` is supplied.

## Arithmetic policy

Correctness-critical computation remains integer-valued JavaScript `number` arithmetic. The engine deliberately supports effective moduli through `rEff <= 100` and rejects larger effective moduli. The conservative integer-safety boundary in `asetsCore.ts` remains authoritative.

The expensive family identity remains `[engineVersion, rEff, residue0, residue1, residue2]` after effective reduction and canonicalization under simultaneous unit scaling and S3 axis permutation. Dimension and block multiplicities are not part of the key. Equivalent group presentations therefore share one family result.

## Packed interactive CSP

`src/asetsFast.ts` changes representation and reuse, not search semantics:

- every modulus point is stored once;
- principal-divisor boxes store compact point IDs instead of repeated point tuples;
- each point character is computed once per clicked family;
- epoch-marked dense arrays replace repeated per-box `seen` allocations;
- candidate assignments store character IDs and point IDs;
- the CSP assigned state compares point IDs rather than three-coordinate tuples;
- minimum-domain branching, singleton propagation, tie-breaking and deterministic emission order are unchanged.

The amount of repeated point material in the frozen representation grows quickly with r. At r=50 there are 564 distinct modulus-universe points but 17,046 point references in the principal boxes; at r=100 there are 1,471 distinct points but 86,914 references. The packed context removes this repeated object work without requiring any preloaded family data.

## Family-local exact geometry reuse

`FamilyGeometryContext` has exactly one-family lifetime. It:

- assigns numeric IDs to distinct transition rows;
- uses collision-free bounded numeric keys instead of string keys in hot maps;
- memoizes row-pair -> primitive canonical normal-line results;
- reuses primitive normal IDs across the family's downsets;
- memoizes quotient-lattice scale per primitive normal line;
- continues to perform exact direct integer dot tests for feasibility.

On the two hard r=50 families, roughly 120k-128k row-pair occurrences collapse to only about 6.3k-6.6k distinct row pairs, and more than 52k normal-line occurrences collapse to fewer than 700 distinct primitive lines per family.

A more invasive incremental dual-cone/double-description prototype was tested and rejected. It gave only modest gains on the two pathological families and was slower on several other large families, so the simpler pairwise exact algorithm with family-local reuse remains the production choice.

## Worker and cache architecture

The optimized worker is designed for a user exploring the group navigator:

- a three-entry in-memory LRU retains only recently used modulus contexts;
- the family-local geometry cache is discarded after that family;
- completed exact family records persist in IndexedDB in 64-record chunks;
- header, chunks and optional group transform are committed together in one final transaction;
- the navigator receives lightweight progress totals every 64 records rather than structured-cloned rich geometry records it does not consume;
- a completed-family navigator cache hit needs only the completed header; record chunks can be loaded lazily by a future Aset geometry visualizer;
- no full canonical JSON serialization/digest is rebuilt on every click. Full normalized equality is an oracle/test invariant, while runtime cache completeness uses the atomic completed-family transaction plus engine/schema versions.

Existing stores remain:

- `asetFamilyHeaders`
- `asetFamilyChunks`
- `asetGroupTransforms`

The engine version remains `portable-asets-reference-v1-ts1` because family semantics have not changed. Older completed version-1 cached families with a digest remain readable; newly completed headers may have `normalizedResultDigest: null`.

## Navigation supersession

Completed clicks reuse the same worker, preserving the modulus LRU. If the user changes group while a family is still running, the React owner terminates that obsolete worker and immediately creates a replacement. Explicit Cancel uses the same mechanism.

This is intentional. Experiments with larger cooperative chunks, `scheduler.yield`, `MessageChannel`, `user-visible` tasks and `user-blocking` tasks either added latency, allowed Chromium background throttling under sustained browsing, or could starve the cancellation message. Main-thread `Worker.terminate()` gives deterministic supersession without forcing every normal computation to yield repeatedly.

The worker protocol still accepts a best-effort cancel request for asynchronous/cache boundaries, but UI responsiveness does not depend on the compute worker hearing it.

## Browser-oriented measurements

The optimized control-flow measurements use managed headless Chromium executing the exact optimized Web Worker. Because the managed page has an opaque origin, IndexedDB is disabled in this harness; these figures do not claim HTTPS IndexedDB read/write latency. Cold wall time includes worker startup.

| Workload | Optimized measurement |
| --- | ---: |
| 59 deterministic navigator-style clicks, wall median | 2.1 ms |
| same sample, wall p95 | 12.35 ms |
| same sample, wall max | 18.7 ms |
| hard r=50 `(1,13,37)`, fresh-worker compute median | 58.4 ms |
| hard r=50 `(1,24,49)`, fresh-worker compute median | 62.9 ms |
| hard r=50 `(1,13,37)`, observed warm-r=50 compute | 48.9 ms |
| hard r=50 `(1,24,49)`, observed warm-r=50 compute | 45.9 ms |
| r=75 `(1,36,74)`, fresh-worker compute median | 134.1 ms |
| r=100 `(1,49,99)`, fresh-worker compute median | 281.8 ms |

The first faithful TypeScript candidate measured about 99.3 ms and 92.0 ms for the two hard r=50 families, 277.4 ms at r=75 and 676.0 ms at r=100 in its earlier Chromium worker harness. Browser timing is noisy across runs, but the optimized direction and tail-latency reduction are large enough to retain.

A rapid-navigation probe started the r=100 hard scaling family, terminated its worker after about 5 ms, and verified the obsolete worker never completed. The replacement worker returned a small r=14 family roughly 20-37 ms after termination, including replacement-worker startup.

## Measurements still required on the deployed HTTPS origin

The managed benchmark cannot honestly measure normal-origin IndexedDB or practical browser heap peaks. The production worker retains IndexedDB timing instrumentation. Before Product acceptance, measure on the exact deployed candidate:

- first completed-family write;
- header-only cache hit;
- lazy record-chunk retrieval once visualization consumes records;
- practical memory while moving through several large families.

## Performance conclusion

The optimized TypeScript path is now deliberately tuned for an empty browser that computes an arbitrary family on demand and becomes faster as the user revisits equivalent families or nearby moduli. It does not depend on downloading the research database or precomputing the finite corpus. The current results still do not justify a Rust/WASM backend for the r<=50 product target.
