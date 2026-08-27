# Portable Asets TypeScript engine validation

This viewer port treats `portable-asets-reference-v1` as the immutable behavioral reference:

- research repository: `lucakollmer/knockout`
- frozen commit: `09da2e40f051e72a932c77df16691d0c908f3fe3`
- reference directory: `research/asets_portable`
- reference core: `research/asets_portable/core.py`
- normalized full-oracle SHA-256: `6825f6544d738f5386c5277c06da27ae3c3ebd235da1d6a5f6c811cf741f100f`
- authoritative generalized-v5 SQLite SHA-256: `a662628f57add19c75b929552684df4cf7b5dfa96de226f47e3a712f82d0e76f`

The Python reference was not modified for this port.

## Product workload

The production workload is interactive and local-first, not bulk regeneration of the generalized-v5 database. A new browser session downloads the application and algorithm but no Aset dataset. Clicking any group must be able to compute its canonical family from scratch. Completed families are cached locally so equivalent presentations and revisits avoid recomputation. Modulus-level box/unit data may be reused while the worker remains on the same modulus, but the search/geometry state for a completed family is disposable.

Performance evaluation therefore prioritizes:

1. cold latency for an arbitrary uncached family;
2. cold hard-family latency;
3. same-modulus warm latency;
4. completed-family IndexedDB reload latency;
5. cancellation/supersession responsiveness while navigating;
6. exact equivalence to the frozen oracle.

## Exactness gate

The original ported `src/asetsCore.ts` passed an exact differential against the authoritative generalized-v5 SQLite corpus. The optimized interactive geometry path in `src/asetsGeometry.ts` was then independently revalidated over the same complete corpus in four contiguous fixed subsets covering every family:

| Measure | Result |
| --- | ---: |
| Canonical families | 12,709 / 12,709 exact |
| Representation classes represented | 73,571 |
| Terminal downsets compared | 483,780 / 483,780 exact |
| Noncoherent downsets | 498 |

For every family, the validator compared the complete normalized result, including canonical downsets, transition rows, coherence, exact witnesses, active/inactive axes, geometry shape and quotient-lattice low rays. The comparison used exact normalized payload equality, not sampling. `tests/asetsOracleV5.external.test.ts` now exercises the CSP plus the optimized family-local geometry path.

Frozen sentinel coverage includes effective orbit reduction/canonicalization, small families, zero/repeated axes, a noncoherent family, both hard `r=50` families, streaming versus collected results, quotient-lattice scaling, cancellation, and direct old-versus-optimized geometry equality.

## Arithmetic policy

Correctness-critical computation uses integer-valued JavaScript `number` arithmetic. The current engine deliberately supports effective moduli through `rEff <= 100` and rejects larger effective moduli. It asserts safe integers at critical boundaries and uses the conservative coherence bound `27*r^5` when checking the supported modulus boundary. A presentation with a larger original modulus is accepted only when effective common-factor reduction brings `rEff` into the supported range.

The expensive family identity is `[engineVersion, rEff, residue0, residue1, residue2]` after effective reduction and canonicalization under simultaneous unit multiplication and `S3` axis permutation. Dimension and block multiplicities are not part of the family key. A transformation certificate retains the reduction, unit multiplier and axis permutation needed to transport canonical coordinates back to the selected presentation.

## Family-local geometry optimization

Browser profiling showed that hard-family CSP search was already much cheaper than exact geometry. The optimized path therefore leaves the frozen search mathematics unchanged and removes repeated exact geometry work inside one clicked family.

`FamilyGeometryContext` has exactly one-family lifetime. Within that family it:

- assigns numeric IDs to distinct transition rows;
- packs bounded row and primitive-normal coordinates into collision-free safe-integer keys instead of allocating string keys in the hot geometry path;
- memoizes row-pair -> primitive canonical normal-line results;
- reuses primitive normal IDs across the family's downsets;
- memoizes quotient-lattice scale per primitive normal line;
- uses direct integer dot products for feasibility because caching line/row signs was measured to be slower than recomputing the very cheap dot product.

Nothing in this cache is required to exist before a family is requested, and it is not retained as an unbounded cross-family search structure.

On the two hard `r=50` families, 128,285 and 121,678 row-pair occurrences collapse to only 6,575 and 6,318 distinct row pairs respectively; their normal-line occurrences collapse to fewer than 700 distinct primitive lines per family. That is the reuse exploited by this optimization.

In same-process Node measurements of the actual compiled `asetsGeometry.ts` module, the geometry stage for the hard families improved by roughly 2-3x across repeated trials. Across five passes of a deterministic 309-family sample (12,555 records), the median aggregate geometry speedup was about 1.96x; tiny families can be slightly slower in percentage terms because the absolute geometry cost is already well below a millisecond, which is not an interactive bottleneck.

## Worker and cache architecture

`src/workers/asets.worker.ts` maintains one active modulus context and computes one canonical family at a time. Fresh computation remains cancellable at 16-record event-loop intervals, but persistence is decoupled from that yield cadence:

- UI/progress yield interval: 16 records;
- IndexedDB family chunk: 64 records;
- each cache-chunk write stores the chunk and progress header in one IndexedDB transaction;
- completed cached chunks are fetched in one readonly transaction before deterministic incremental delivery;
- stores remain `asetFamilyHeaders`, `asetFamilyChunks`, and `asetGroupTransforms`;
- existing version-1 16-record cached families remain readable because chunk size is not part of the cache schema or family identity.

A newly selected family supersedes obsolete work. Completed cached families load without recomputation. Production UI state keeps progress/totals rather than retaining all exact records in React memory.

## Original browser worker measurements

The baseline port was measured in Chromium before the family-local geometry optimization:

| Family | Downsets | Context ms | CSP ms | Geometry ms | Serialization/chunk ms | Total worker ms | Wall ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `r=12 (3,4,6)` | 2 | 0.4 | 0.9 | 1.6 | 0.1 | 4.1 | 11.5 |
| `r=46 (1,10,12)` | 23 | 2.9 | 11.0 | 3.2 | 0.3 | 19.3 | 19.6 |
| family 12309, `r=50 (1,13,37)` | 385 | 0.9 | 10.6 | 59.4 | 3.9 | 99.3 | 100.1 |
| family 12515, `r=50 (1,24,49)` warm context | 386 | 0.0 | 12.3 | 55.9 | 3.6 | 92.0 | 93.0 |
| `r=60 (1,29,59)` | 539 | 2.2 | 12.3 | 84.1 | 5.4 | 134.8 | 135.2 |
| `r=75 (1,36,74)` | 813 | 2.8 | 29.2 | 170.3 | 9.3 | 277.4 | 277.7 |
| `r=100 (1,49,99)` | 1,399 | 4.8 | 54.3 | 468.7 | 32.4 | 676.0 | 676.7 |

For the baseline `r=100 (1,49,99)`, cancellation requested after the first 16-record delivery was observed 10.2 ms later. The optimized worker preserves the same 16-record event-loop yield cadence even though IndexedDB writes are less frequent.

The managed Chromium benchmark environment used for the baseline had an opaque origin, so IndexedDB and `crypto.subtle` were denied there. Production code records IndexedDB read/write timings on normal HTTPS origins. An exact candidate browser-worker rerun on a normal origin remains the right final measurement for cache latency and practical memory.

## Performance conclusion

The first post-port optimization improves the expensive hard-family geometry path without preloading data or changing the Aset mathematics. It is specifically designed for a browser that starts empty and computes families as the user explores groups. Ordinary TypeScript remains the preferred implementation. A compiled geometry backend should only be reconsidered if the optimized exact browser-worker measurements, particularly beyond the current `r <= 50` product target, expose a remaining material latency problem.
