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

function coordinateKey(x: number, y: number, z: number, r: number): number {
  return (x * r + y) * r + z;
}

export function buildFastModulusContext(r: number, cancelCheck?: CancelCheck): FastModulusContext {
  assertExactRuntimeModulus(r);

  const points: Point[] = [];
  const pointIds = new Map<number, number>();
  for (let x = 0; x < r; x += 1) {
    for (let y = 0; y < r; y += 1) {
      const xy = (x + 1) * (y + 1);
      if (xy > r) break;
      const maxZ = Math.floor(r / xy) - 1;
      for (let z = 0; z <= maxZ; z += 1) {
        const pointId = points.length;
        points.push([x, y, z]);
        pointIds.set(coordinateKey(x, y, z, r), pointId);
      }
    }
  }

  // Sparse coordinate lookup avoids the old O(r^3) temporary dense table.
  // Uint32 IDs remove the former 65,535-point representation ceiling.
  const boxPointIds: Uint32Array[] = new Array(points.length);
  for (let pointId = 0; pointId < points.length; pointId += 1) {
    const [x, y, z] = points[pointId];
    const ids = new Uint32Array((x + 1) * (y + 1) * (z + 1));
    let index = 0;
    for (let i = 0; i <= x; i += 1) {
      for (let j = 0; j <= y; j += 1) {
        for (let k = 0; k <= z; k += 1) {
          const encoded = pointIds.get(coordinateKey(i, j, k, r));
          if (encoded === undefined) throw new Error('internal fast modulus point lookup failure');
          ids[index] = encoded;
          index += 1;
        }
      }
    }
    boxPointIds[pointId] = ids;
    if ((pointId & 127) === 0) maybeCancel(cancelCheck);
  }

  return { r, points, boxPointIds };
}

function familyCandidatesFast(
  context: FastModulusContext,
  residues: Point,
  cancelCheck?: CancelCheck,
  metrics?: SearchMetrics,
): readonly (readonly FastCandidate[])[] {
  const { r, points, boxPointIds } = context;
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
    bucket.sort((first, second) => comparePointByDegree(points[first.pointId], points[second.pointId]));
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
  } = {},
): Generator<readonly Point[]> {
  assertExactRuntimeModulus(rInput);
  if (residuesInput.length !== 3) throw new Error('expected three residues');
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
        assigned[chi] = assignments[index + 1];
        undoStack.push(chi);
        assignedCount += 1;
      }
    }
  };

  const undoTo = (mark: number): void => {
    while (undoStack.length > mark) {
      const chi = undoStack.pop();
      if (chi === undefined) throw new Error('internal fast CSP undo failure');
      assigned[chi] = 0;
      assignedCount -= 1;
    }
  };

  const emit = (): readonly Point[] => {
    const downset: Point[] = [];
    for (let chi = 0; chi < r; chi += 1) {
      const encoded = assigned[chi];
      if (encoded !== 0) downset.push(context.points[encoded - 1]);
    }
    downset.sort(comparePointByDegree);
    return downset;
  };

  function* search(): Generator<readonly Point[]> {
    if (options.metrics) options.metrics.nodes += 1;
    maybeCancel(options.cancelCheck);
    const frameMark = undoStack.length;
    try {
      while (true) {
        if (assignedCount === r) {
          yield emit();
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
        for (const candidate of bestDomain) {
          const branchMark = undoStack.length;
          apply(candidate);
          try {
            yield* search();
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

  yield* search();
}

export function enumerateFastDownsets(
  r: number,
  residues: readonly number[],
  options: {
    modulusContext?: FastModulusContext;
    cancelCheck?: CancelCheck;
    metrics?: SearchMetrics;
  } = {},
): readonly (readonly Point[])[] {
  return [...iterFastDownsets(r, residues, options)].sort(compareDownsets);
}
