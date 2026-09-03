import {
  CancelledError,
  compareDownsets,
  type CancelCheck,
  type Point,
  type SearchMetrics,
} from './asetsCore';
import { assertExactRuntimeModulus } from './asetsRuntime';

export type FastModulusContext = {
  r: number;
  points: readonly Point[];
  boxPointIds: readonly Uint32Array[];
  pointRanks: Uint32Array;
  pointsByRank: readonly Point[];
};

export type FastRootPartition = {
  index: number;
  count: number;
};

type FastCandidate = {
  pointId: number;
  // Interleaved [character, encodedPointId] pairs. encodedPointId is pointId + 1,
  // matching assigned[] so the hot compatibility/apply loops walk one array and
  // avoid a per-entry conversion.
  assignments: readonly number[];
};

function maybeCancel(cancelCheck?: CancelCheck): void {
  if (cancelCheck?.()) throw new CancelledError();
}

function comparePoint(first: Point, second: Point): number {
  return first[0] - second[0] || first[1] - second[1] || first[2] - second[2];
}

function comparePointByDegree(first: Point, second: Point): number {
  const firstDegree = first[0] + first[1] + first[2];
  const secondDegree = second[0] + second[1] + second[2];
  return firstDegree - secondDegree || comparePoint(first, second);
}

export function buildFastModulusContext(r: number, cancelCheck?: CancelCheck): FastModulusContext {
  assertExactRuntimeModulus(r);

  const points: Point[] = [];
  // Points are emitted in x/y/z blocks. Record the exact start ID of every
  // valid (x,y) block so downward-box IDs can be computed as start + z, avoiding
  // a hash-map lookup for every cell in every box.
  const pointStartsByXY: Uint32Array[] = new Array(r);
  for (let x = 0; x < r; x += 1) {
    const yCount = Math.floor(r / (x + 1));
    const yStarts = new Uint32Array(yCount);
    for (let y = 0; y < yCount; y += 1) {
      yStarts[y] = points.length;
      const zCount = Math.floor(r / ((x + 1) * (y + 1)));
      for (let z = 0; z < zCount; z += 1) points.push([x, y, z]);
    }
    pointStartsByXY[x] = yStarts;
    if ((x & 31) === 0) maybeCancel(cancelCheck);
  }

  // Uint32 IDs remove the former 65,535-point representation ceiling. Every
  // coordinate in a point's downward box is valid, and its ID is the precomputed
  // (x,y) block start plus z.
  const boxPointIds: Uint32Array[] = new Array(points.length);
  for (let pointId = 0; pointId < points.length; pointId += 1) {
    const [x, y, z] = points[pointId];
    const ids = new Uint32Array((x + 1) * (y + 1) * (z + 1));
    let index = 0;
    for (let i = 0; i <= x; i += 1) {
      const yStarts = pointStartsByXY[i];
      for (let j = 0; j <= y; j += 1) {
        const start = yStarts[j];
        for (let k = 0; k <= z; k += 1) {
          ids[index] = start + k;
          index += 1;
        }
      }
    }
    boxPointIds[pointId] = ids;
    if ((pointId & 127) === 0) maybeCancel(cancelCheck);
  }

  // Every emitted downset is sorted by this same degree/lexicographic order.
  // Precompute ranks once so the search can maintain a selected-rank bitset and
  // avoid sorting r Point objects for every completed solution.
  const rankedPointIds = Array.from({ length: points.length }, (_, pointId) => pointId)
    .sort((firstId, secondId) => comparePointByDegree(points[firstId], points[secondId]));
  const pointRanks = new Uint32Array(points.length);
  const pointsByRank: Point[] = new Array(points.length);
  for (let rank = 0; rank < rankedPointIds.length; rank += 1) {
    const pointId = rankedPointIds[rank];
    pointRanks[pointId] = rank;
    pointsByRank[rank] = points[pointId];
  }

  return { r, points, boxPointIds, pointRanks, pointsByRank };
}

function familyCandidatesFast(
  context: FastModulusContext,
  residues: Point,
  cancelCheck?: CancelCheck,
  metrics?: SearchMetrics,
): readonly (readonly FastCandidate[])[] {
  const { r, points, boxPointIds, pointRanks } = context;
  const characters = new Uint32Array(points.length);
  for (let pointId = 0; pointId < points.length; pointId += 1) {
    const point = points[pointId];
    characters[pointId] = (
      point[0] * residues[0]
      + point[1] * residues[1]
      + point[2] * residues[2]
    ) % r;
  }

  const buckets: FastCandidate[][] = Array.from({ length: r }, () => []);
  const seenEpoch = new Uint32Array(r);
  let epoch = 1;

  for (let pointId = 0; pointId < points.length; pointId += 1) {
    if (epoch === 0xffffffff) {
      seenEpoch.fill(0);
      epoch = 1;
    }
    const currentEpoch = epoch;
    epoch += 1;
    const boxIds = boxPointIds[pointId];
    const assignments: number[] = [];
    let valid = true;

    for (let index = 0; index < boxIds.length; index += 1) {
      const assignedPointId = boxIds[index];
      const chi = characters[assignedPointId];
      if (seenEpoch[chi] === currentEpoch) {
        valid = false;
        break;
      }
      seenEpoch[chi] = currentEpoch;
      assignments.push(chi, assignedPointId + 1);
    }

    if (valid) {
      buckets[characters[pointId]].push({
        pointId,
        assignments,
      });
    }
    if ((pointId & 127) === 0) maybeCancel(cancelCheck);
  }

  for (const bucket of buckets) {
    bucket.sort((first, second) => pointRanks[first.pointId] - pointRanks[second.pointId]);
  }
  if (metrics) metrics.candidateCount = buckets.reduce((total, bucket) => total + bucket.length, 0);
  return buckets;
}

export function* iterFastDownsets(
  rInput: number,
  residuesInput: readonly number[],
  options: {
    modulusContext?: FastModulusContext;
    cancelCheck?: CancelCheck;
    metrics?: SearchMetrics;
    rootPartition?: FastRootPartition;
  } = {},
): Generator<readonly Point[]> {
  assertExactRuntimeModulus(rInput);
  if (residuesInput.length !== 3) throw new Error('expected three residues');
  const rootPartition = options.rootPartition;
  if (rootPartition && (
    !Number.isSafeInteger(rootPartition.index)
    || !Number.isSafeInteger(rootPartition.count)
    || rootPartition.count < 1
    || rootPartition.index < 0
    || rootPartition.index >= rootPartition.count
  )) throw new Error('invalid fast CSP root partition');

  const r = rInput;
  const residues: Point = [
    ((residuesInput[0] % r) + r) % r,
    ((residuesInput[1] % r) + r) % r,
    ((residuesInput[2] % r) + r) % r,
  ];
  const context = options.modulusContext ?? buildFastModulusContext(r, options.cancelCheck);
  if (context.r !== r) throw new Error('fast modulus context does not match r');

  const candidates = familyCandidatesFast(context, residues, options.cancelCheck, options.metrics);
  const assigned = new Uint32Array(r);
  assigned[0] = 1;
  let assignedCount = 1;
  const undoStack: number[] = [];
  const selectedRankBits = new Uint32Array(Math.ceil(context.pointsByRank.length / 32));

  const markSelectedPoint = (encodedPointId: number): void => {
    const rank = context.pointRanks[encodedPointId - 1];
    const wordIndex = rank >>> 5;
    const mask = 1 << (rank & 31);
    selectedRankBits[wordIndex] = (selectedRankBits[wordIndex] | mask) >>> 0;
  };

  const unmarkSelectedPoint = (encodedPointId: number): void => {
    const rank = context.pointRanks[encodedPointId - 1];
    const wordIndex = rank >>> 5;
    const mask = 1 << (rank & 31);
    selectedRankBits[wordIndex] = (selectedRankBits[wordIndex] & ~mask) >>> 0;
  };

  markSelectedPoint(1);

  const compatible = (candidate: FastCandidate): boolean => {
    if (options.metrics) options.metrics.compatibilityChecks += 1;
    const assignments = candidate.assignments;
    for (let index = 0; index < assignments.length; index += 2) {
      const chi = assignments[index];
      const current = assigned[chi];
      if (current !== 0 && current !== assignments[index + 1]) return false;
    }
    return true;
  };

  const apply = (candidate: FastCandidate): void => {
    const assignments = candidate.assignments;
    for (let index = 0; index < assignments.length; index += 2) {
      const chi = assignments[index];
      if (assigned[chi] === 0) {
        const encodedPointId = assignments[index + 1];
        assigned[chi] = encodedPointId;
        markSelectedPoint(encodedPointId);
        undoStack.push(chi);
        assignedCount += 1;
      }
    }
  };

  const undoTo = (mark: number): void => {
    while (undoStack.length > mark) {
      const chi = undoStack.pop();
      if (chi === undefined) throw new Error('internal fast CSP undo failure');
      const encodedPointId = assigned[chi];
      if (encodedPointId === 0) throw new Error('internal fast CSP undo point failure');
      unmarkSelectedPoint(encodedPointId);
      assigned[chi] = 0;
      assignedCount -= 1;
    }
  };

  const emit = (): readonly Point[] => {
    const downset: Point[] = new Array(r);
    let outputIndex = 0;
    for (let wordIndex = 0; wordIndex < selectedRankBits.length; wordIndex += 1) {
      let word = selectedRankBits[wordIndex] >>> 0;
      while (word !== 0) {
        const lowBit = word & -word;
        const bitIndex = 31 - Math.clz32(lowBit);
        const rank = (wordIndex << 5) + bitIndex;
        const point = context.pointsByRank[rank];
        if (point === undefined) throw new Error('internal fast CSP point-rank failure');
        downset[outputIndex] = point;
        outputIndex += 1;
        word = (word & (word - 1)) >>> 0;
      }
    }
    if (outputIndex !== r) throw new Error('internal fast CSP selected-rank count failure');
    return downset;
  };

  function* search(partitionPending: boolean): Generator<readonly Point[]> {
    if (options.metrics) options.metrics.nodes += 1;
    maybeCancel(options.cancelCheck);
    const frameMark = undoStack.length;
    try {
      while (true) {
        if (assignedCount === r) {
          // A family with no non-singleton branch belongs to partition zero only.
          if (!partitionPending || !rootPartition || rootPartition.index === 0) yield emit();
          return;
        }

        let bestCharacter = -1;
        let bestDomain: FastCandidate[] | null = null;
        let scratchDomain: FastCandidate[] = [];
        for (let chi = 1; chi < r; chi += 1) {
          if (assigned[chi] !== 0) continue;
          scratchDomain.length = 0;
          let cutOff = false;
          for (const candidate of candidates[chi]) {
            if (!compatible(candidate)) continue;
            scratchDomain.push(candidate);
            // Characters are visited in ascending order, so an equal-sized later
            // domain cannot win the deterministic MRV tie-break. Stop as soon as
            // it is known not to beat the current best domain.
            if (bestDomain !== null && scratchDomain.length >= bestDomain.length) {
              cutOff = true;
              break;
            }
          }
          if (!cutOff && scratchDomain.length === 0) return;
          if (cutOff) continue;
          if (bestDomain === null || scratchDomain.length < bestDomain.length) {
            bestCharacter = chi;
            const previousBest = bestDomain;
            bestDomain = scratchDomain;
            scratchDomain = previousBest ?? [];
          }
          if (bestDomain.length === 1) break;
        }

        if (bestDomain === null || bestCharacter < 0) throw new Error('internal fast CSP domain failure');
        if (bestDomain.length === 1) {
          apply(bestDomain[0]);
          if (options.metrics) options.metrics.singletonPropagations += 1;
          continue;
        }

        if (options.metrics) options.metrics.branches += 1;
        let branchStart = 0;
        let branchEnd = bestDomain.length;
        if (partitionPending && rootPartition) {
          branchStart = Math.floor(bestDomain.length * rootPartition.index / rootPartition.count);
          branchEnd = Math.floor(bestDomain.length * (rootPartition.index + 1) / rootPartition.count);
        }
        for (let branchIndex = branchStart; branchIndex < branchEnd; branchIndex += 1) {
          const branchMark = undoStack.length;
          apply(bestDomain[branchIndex]);
          try {
            yield* search(false);
          } finally {
            undoTo(branchMark);
          }
        }
        return;
      }
    } finally {
      undoTo(frameMark);
    }
  }

  yield* search(true);
}

export function enumerateFastDownsets(
  r: number,
  residues: readonly number[],
  options: {
    modulusContext?: FastModulusContext;
    cancelCheck?: CancelCheck;
    metrics?: SearchMetrics;
    rootPartition?: FastRootPartition;
  } = {},
): readonly (readonly Point[])[] {
  return [...iterFastDownsets(r, residues, options)].sort(compareDownsets);
}
