# Interactive A-set algorithm

This document describes the release implementation in `src/asetsFast.ts`, `src/asetsGeometry.ts`, and the A-set workers. It is intended to explain the algorithm without requiring the reader to reconstruct its design from the performance-experiment history.

## 1. What is enumerated

For an effective cyclic family `(r; a,b,c)`, each lattice point `(x,y,z)` has character

`chi(x,y,z) = a*x + b*y + c*z (mod r)`.

An A-set is represented as a downward-closed set of exactly `r` lattice points whose character map is bijective. The fast enumerator constructs those sets directly and emits them in a deterministic order.

## 2. Modulus context

`buildFastModulusContext(r)` contains data that depends only on `r` and can therefore be reused across coefficient triples.

It builds:

1. every lattice point that can occur in a downward box of size at most `r`;
2. the point IDs in each point's downward box;
3. a stable point rank ordered by total degree and then lexicographically.

The downward-box IDs are computed from precomputed `(x,y)` block starts rather than hash-map lookups. The stable rank is built with degree buckets rather than a comparison sort.

## 3. Candidate boxes

For a specific residue triple, `familyCandidatesFast` computes the character of every modulus-context point.

A point defines a candidate downward box. The candidate is valid only when the characters appearing in that box are all distinct. A valid candidate stores its assignments as an interleaved array:

`[character, encodedPointId, character, encodedPointId, ...]`.

Candidates are bucketed by the character of their maximal point and kept in stable point-rank order.

## 4. Search state

The DFS keeps four small pieces of mutable state:

- `assigned[chi]`: the selected point for a character, encoded as `pointId + 1`; zero means unassigned;
- `assignedCount`: number of assigned characters;
- `undoStack`: characters assigned since the current DFS frame;
- `selectedRankBits`: a bitset of selected point ranks used to emit the final downset in stable order without sorting every solution.

Character zero is initially assigned to the origin.

Applying a candidate fills only previously unassigned characters. Undo restores assignments and point bits back to a saved stack mark.

## 5. MRV search

At each nonterminal state the search chooses the unassigned character with the smallest compatible candidate domain (minimum remaining values / MRV).

Compatibility is intentionally simple: a candidate is compatible when every character it touches is either unassigned or already assigned to the same point.

Characters are examined in ascending order, which defines the deterministic MRV tie-break. Candidate buckets are also already ordered. These two rules define the exact DFS output order.

Singleton domains are propagated immediately. A zero-size domain ends the branch. When all `r` characters are assigned, the point-rank bitset is converted directly to the emitted downset.

## 6. Parallel partitioning

Parallelism is deliberately conservative. The coordinator uses at most four physical shard workers and drains their output in shard-index order, so concatenated output is identical to single-thread DFS order.

There are two partition modes.

### Ordinary root slicing

For most parallel families, the first non-singleton MRV domain is divided into contiguous candidate ranges. Each shard receives one contiguous range. This is simple and preserves global DFS order.

### Opposite-pair depth-two prefixes

Measured hard families containing an opposite coefficient pair can have extremely uneven work under an equal root split. For these families only, the enumerator deterministically expands the DFS through at most two non-singleton branch decisions, while still propagating forced singleton domains.

Each resulting ordered prefix task receives a cheap work estimate:

`next-domain-size * remaining-unassigned-characters`.

The ordered task list is divided into contiguous ranges with approximately equal cumulative estimated weight. Because ranges remain contiguous and the coordinator still drains shards in order, exact DFS output order is preserved.

This depth-two policy is the measured release optimization. It is not a general dynamic scheduler.

## 7. When workers are used

The coordinator stays single-threaded below the measured threshold. For larger families it enables parallelism when coefficient structure indicates a hard family:

- stabilizer size 1 with at least one opposite coefficient pair; or
- sufficiently high `r` with stabilizer size at most 2.

Hardware with at least eight logical threads uses four shards; lower eligible hardware uses two. The release maximum is four shards.

## 8. Geometry

Enumeration and geometry are separate stages. Every emitted downset is passed to `geometryRecordCached`.

The geometry stage:

1. reconstructs the character-to-point map;
2. computes and caches transition rows;
3. maintains cached row-pair line data across consecutive records;
4. reuses an exact coherence witness when possible to derive supporting normals through a projected convex hull;
5. falls back to the exact supporting-line scan when that shortcut is not valid;
6. computes coherence, witness, active/inactive axes, shape, and low rays.

All shortcuts are fail-closed: they fall back to exact logic rather than changing the mathematical result.

## 9. Caching and ordering

Completed families are cached in IndexedDB in 64-record chunks. Live worker messages also use bounded chunks. Cache reads must preserve the same record order as fresh computation.

For parallel families, shard messages may arrive out of order, but the coordinator buffers them and releases only the earliest unfinished shard. This is what makes the parallel implementation observationally equivalent to deterministic single-thread enumeration.

## 10. Correctness tests

The release gate checks several independent invariants:

- settled oracle-universe parity;
- frozen digests for representative families;
- cached geometry versus the reference geometry implementation;
- effective-family reduction;
- cancellation during cold context construction;
- ordinary root-partition concatenation equals single-thread order;
- opposite-pair depth-two partition concatenation equals single-thread order.

## 11. Experiments that are not in the release algorithm

The following ideas were measured and rejected. Their implementations live only in historical review commits/branches and are not part of the release runtime:

- eight physical shard workers;
- cache chunks larger than 64 records;
- incremental candidate-conflict/domain-size CSP bookkeeping;
- standalone static weighted root partitioning;
- geometry `Point`-identity state caching.

They are omitted because controlled same-machine benchmarks showed regressions, no reliable benefit, or unacceptable imbalance. Future optimization should start from a concrete failing workload rather than reintroducing these mechanisms by default.
