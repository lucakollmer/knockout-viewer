# Portable Asets TypeScript engine validation

This viewer port treats `portable-asets-reference-v1` as the immutable behavioral reference:

- research repository: `lucakollmer/knockout`
- frozen commit: `09da2e40f051e72a932c77df16691d0c908f3fe3`
- reference directory: `research/asets_portable`
- reference core: `research/asets_portable/core.py`
- normalized full-oracle SHA-256: `6825f6544d738f5386c5277c06da27ae3c3ebd235da1d6a5f6c811cf741f100f`
- authoritative generalized-v5 SQLite SHA-256: `a662628f57add19c75b929552684df4cf7b5dfa96de226f47e3a712f82d0e76f`

The Python reference was not modified for this port.

## Exactness gate

The final `src/asetsCore.ts` source passed an exact differential against the authoritative generalized-v5 SQLite corpus:

| Measure | Result |
| --- | ---: |
| Canonical families | 12,709 / 12,709 exact |
| Representation classes represented | 73,571 |
| Terminal downsets compared | 483,780 / 483,780 exact |
| Noncoherent downsets | 498 |

For every family, the validator compared the complete normalized result, including canonical downsets, transition rows, coherence, exact witnesses, active/inactive axes, geometry shape and quotient-lattice low rays. The comparison used exact normalized payload equality, not sampling.

Frozen sentinel coverage also includes effective orbit reduction/canonicalization, small families, zero/repeated axes, a noncoherent family, the 386-downset hard `r=50` family, streaming versus collected results, quotient-lattice scaling and cancellation.

## Arithmetic policy

Correctness-critical computation uses integer-valued JavaScript `number` arithmetic. The current engine deliberately supports effective moduli through `rEff <= 100` and rejects larger effective moduli. It asserts safe integers at critical boundaries and uses the conservative coherence bound `27*r^5` when checking the supported modulus boundary. A presentation with a larger original modulus is accepted only when effective common-factor reduction brings `rEff` into the supported range.

The expensive family identity is `[engineVersion, rEff, residue0, residue1, residue2]` after effective reduction and canonicalization under simultaneous unit multiplication and `S3` axis permutation. Dimension and block multiplicities are not part of the family key. A transformation certificate retains the reduction, unit multiplier and axis permutation needed to transport canonical coordinates back to the selected presentation.

## Worker and cache architecture

`src/workers/asets.worker.ts` maintains one active modulus context, computes one canonical family at a time, streams deterministic 16-record chunks, checks cancellation at search-node and record/chunk boundaries, and stores results in IndexedDB using:

- `asetFamilyHeaders`
- `asetFamilyChunks`
- `asetGroupTransforms`

A newly selected family supersedes obsolete work. Completed cached families stream from IndexedDB without recomputation. Production UI state keeps progress/totals rather than retaining all exact records in React memory.

## Browser worker measurements

These measurements executed the emitted TypeScript computational worker in Chromium. The harness used the same exact core/search/geometry code and worker chunk scheduling. Because this managed Chromium environment blocks normal URL navigation and leaves `about:blank` as an opaque origin, IndexedDB and `crypto.subtle` are denied there. For the benchmark harness only, cache access was disabled and the digest step retained stable serialization but omitted the final WebCrypto hash. Production code is unchanged and records IndexedDB read/write timings when those APIs are available.

| Family | Downsets | Context ms | CSP ms | Geometry ms | Serialization/chunk ms | Total worker ms | Wall ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `r=12 (3,4,6)` | 2 | 0.4 | 0.9 | 1.6 | 0.1 | 4.1 | 11.5 |
| `r=46 (1,10,12)` | 23 | 2.9 | 11.0 | 3.2 | 0.3 | 19.3 | 19.6 |
| family 12309, `r=50 (1,13,37)` | 385 | 0.9 | 10.6 | 59.4 | 3.9 | 99.3 | 100.1 |
| family 12515, `r=50 (1,24,49)` warm context | 386 | 0.0 | 12.3 | 55.9 | 3.6 | 92.0 | 93.0 |
| `r=60 (1,29,59)` | 539 | 2.2 | 12.3 | 84.1 | 5.4 | 134.8 | 135.2 |
| `r=75 (1,36,74)` | 813 | 2.8 | 29.2 | 170.3 | 9.3 | 277.4 | 277.7 |
| `r=100 (1,49,99)` | 1,399 | 4.8 | 54.3 | 468.7 | 32.4 | 676.0 | 676.7 |

For `r=100 (1,49,99)`, cancellation was requested after the first 16-record chunk and observed 10.2 ms later. The worker uses `scheduler.postTask(..., { priority: 'background' })` when available, with a timer fallback, so chunk yields permit incoming cancellation/supersession messages without the large timer-clamping overhead seen in the initial benchmark implementation.

IndexedDB read/write latency and a practical browser memory peak remain environment-dependent measurements for manual browser review on a normal HTTPS origin; they are instrumented by the production worker but could not be measured honestly in the managed opaque-origin Chromium harness.

## Performance conclusion

Ordinary TypeScript is sufficient for the current `r <= 50` product target and remains usable at the `r=100` scaling probe. Exact geometry is the dominant high-modulus stage, but the current browser measurements do not justify a Rust/WASM backend. Reconsider a small WASM geometry experiment only if normal-browser profiling or materially larger supported moduli expose a real latency problem.
