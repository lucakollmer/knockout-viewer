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
  id: number;
  ownerCharacter: number;
  pointId: number;
  // Interleaved [character, encodedPointId] pairs. encodedPointId is pointId + 1,
  // matching assigned[] so the hot apply/undo loops walk one array and avoid a
  // per-entry conversion.
  assignments: readonly number[];
};

type FastCandidateSet = {
  buckets: readonly (readonly FastCandidate[])[];
  all: readonly FastCandidate[];
  // For each assigned character, interleaved [candidateId, encodedPointId]
  // references for every candidate that constrains that character.
  assignmentRefs: readonly Uint32Array[];
};

function maybeCancel(cancelCheck?: CancelCheck): void {
  if (cancelCheck?.()) throw new CancelledError();
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

  // Point generation is already lexicographic in x/y/z. Stable degree buckets
  // therefore produce the exact degree/lexicographic order without an O(n log n)
  // comparison sort.
  const degreeCounts = new Uint32Array(r);
  for (const point of points) degreeCounts[point[0] + point[1] + point[2]] += 1;
  const nextRankByDegree = new Uint32Array(r);
  let rankOffset = 0;
  for (let degree = 0; degree < r; degree += 1) {
    nextRankByDegree[degree] = rankOffset;
    rankOffset += degreeCounts[degree];
  }
  const pointRanks = new Uint32Array(points.length);
  const pointsByRank: Point[] = new Array(points.length);
  for (let pointId = 0; pointId < points.length; pointId += 1) {
    const point = points[pointId];
    const degree = point[0] + point[1] + point[2];
    const rank = nextRankByDegree[degree];
    nextRankByDegree[degree] = rank + 1;
    pointRanks[pointId] = rank;
    pointsByRank[rank] = point;
  }

  return { r, points, boxPointIds, pointRanks, pointsByRank };
}

function familyCandidatesFast(
  context: FastModulusContext,
  residues: Point,
  cancelCheck?: CancelCheck,
  metrics?: SearchMetrics,
): FastCandidateSet {
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
      const ownerCharacter = characters[pointId];
      buckets[ownerCharacter].push({
        id: -1,
        ownerCharacter,
        pointId,
        assignments,
      });
    }
    if ((pointId & 127) === 0) maybeCancel(cancelCheck);
  }

  const all: FastCandidate[] = [];
  for (let chi = 0; chi < r; chi += 1) {
    const bucket = buckets[chi];
    bucket.sort((first, second) => pointRanks[first.pointId] - pointRanks[second.pointId]);
    for (const candidate of bucket) {
      candidate.id = all.length;
      all.push(candidate);
    }
  }
  if (metrics) metrics.candidateCount = all.length;

  // Build a compact inverted index once. Search then updates candidate conflict
  // counts only when an assignment changes, rather than re-walking every
  // candidate's assignments during every MRV scan.
  const refCounts = new Uint32Array(r);
  for (const candidate of all) {
    const assignments = candidate.assignments;
    for (let index = 0; index < assignments.length; index += 2) {
      refCounts[assignments[index]] += 1;
    }
  }
  const assignmentRefs: Uint32Array[] = new Array(r);
  const refOffsets = new Uint32Array(r);
  for (let chi = 0; chi < r; chi += 1) assignmentRefs[chi] = new Uint32Array(refCounts[chi] * 2);
  for (const candidate of all) {
    const assignments = candidate.assignments;
    for (let index = 0; index < assignments.length; index += 2) {
      const chi = assignments[index];
      const offset = refOffsets[chi];
      const refs = assignmentRefs[chi];
      refs[offset] = candidate.id;
      refs[offset + 1] = assignments[index + 1];
      refOffsets[chi] = offset + 2;
    }
  }

  return { buckets, all, assignmentRefs };
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

  const candidateSet = familyCandidatesFast(context, residues, options.cancelCheck, options.metrics);
  const { buckets: candidates, all: allCandidates, assignmentRefs } = candidateSet;
  const assigned = new Uint32Array(r);
  assigned[0] = 1;
  let assignedCount = 1;
  const undoStack: number[] = [];
  const selectedRankBits = new Uint32Array(Math.ceil(context.pointsByRank.length / 32));
  const candidateConflicts = new Uint16Array(allCandidates.length);
  const domainSizes = new Uint32Array(r);
  for (let chi = 0; chi < r; chi += 1) domainSizes[chi] = candidates[chi].length;

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

  const adjustCandidateConflicts = (chi: number, encodedPointId: number, delta: 1 | -1): void => {
    const refs = assignmentRefs[chi];
    for (let index = 0; index < refs.length; index += 2) {
      if (refs[index + 1] === encodedPointId) continue;
      const candidateId = refs[index];
      const before = candidateConflicts[candidateId];
      const ownerCharacter = allCandidates[candidateId].ownerCharacter;
      if (delta === 1) {
        candidateConflicts[candidateId] = before + 1;
        if (before === 0) {
          if (domainSizes[ownerCharacter] === 0) throw new Error('internal fast CSP domain underflow');
          domainSizes[ownerCharacter] -= 1;
        }
      } else {
        if (before === 0) throw new Error('internal fast CSP conflict underflow');
        candidateConflicts[candidateId] = before - 1;
        if (before === 1) domainSizes[ownerCharacter] += 1;
      }
    }
  };

  const apply = (candidate: FastCandidate): void => {
    const assignments = candidate.assignments;
    for (let index = 0; index < assignments.length; index += 2) {
      const chi = assignments[index];
      if (assigned[chi] === 0) {
        const encodedPointId = assignments[index + 1];
        assigned[chi] = encodedPointId;
        adjustCandidateConflicts(chi, encodedPointId, 1);
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
      adjustCandidateConflicts(chi, encodedPointId, -1);
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
        let bestSize = Number.POSITIVE_INFINITY;
        for (let chi = 1; chi < r; chi += 1) {
          if (assigned[chi] !== 0) continue;
          const size = domainSizes[chi];
          if (size === 0) return;
          if (size < bestSize) {
            bestCharacter = chi;
            bestSize = size;
            if (size === 1) break;
          }
        }
        if (bestCharacter < 0 || !Number.isFinite(bestSize)) throw new Error('internal fast CSP domain failure');

        const bestDomain: FastCandidate[] = [];
        for (const candidate of candidates[bestCharacter]) {
          if (options.metrics) options.metrics.compatibilityChecks += 1;
          if (candidateConflicts[candidate.id] === 0) bestDomain.push(candidate);
        }
        if (bestDomain.length !== bestSize) throw new Error('internal fast CSP domain-size mismatch');

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
