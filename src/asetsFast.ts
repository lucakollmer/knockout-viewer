import {
  CancelledError,
  assertSupportedModulus,
  compareDownsets,
  type CancelCheck,
  type Point,
  type SearchMetrics,
} from './asetsCore';

/**
 * Browser-oriented modulus context for the interactive Asets worker.
 *
 * The mathematical universe is identical to buildModulusContext(), but each
 * principal box stores compact point IDs instead of duplicating Point tuples.
 * A fresh browser can build this from r alone; no dataset payload is required.
 */
export type FastModulusContext = {
  r: number;
  points: readonly Point[];
  boxPointIds: readonly Uint16Array[];
};

type FastCandidate = {
  pointId: number;
  characters: readonly number[];
  pointIds: readonly number[];
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
  assertSupportedModulus(r);

  const points: Point[] = [];
  for (let x = 0; x < r; x += 1) {
    for (let y = 0; y < r; y += 1) {
      const xy = (x + 1) * (y + 1);
      if (xy > r) break;
      const maxZ = Math.floor(r / xy) - 1;
      for (let z = 0; z <= maxZ; z += 1) points.push([x, y, z]);
    }
  }
  if (points.length >= 0xffff) throw new Error('fast modulus context exceeds Uint16 point-ID capacity');

  // Temporary dense lookup only during construction. At r<=100 this is at
  // most 1,000,000 Uint16 entries (~2 MB), then it becomes collectible.
  const denseIds = new Uint16Array(r * r * r);
  for (let pointId = 0; pointId < points.length; pointId += 1) {
    const point = points[pointId];
    denseIds[(point[0] * r + point[1]) * r + point[2]] = pointId + 1;
  }

  const boxPointIds: Uint16Array[] = new Array(points.length);
  for (let pointId = 0; pointId < points.length; pointId += 1) {
    const [x, y, z] = points[pointId];
    const ids = new Uint16Array((x + 1) * (y + 1) * (z + 1));
    let index = 0;
    for (let i = 0; i <= x; i += 1) {
      for (let j = 0; j <= y; j += 1) {
        for (let k = 0; k <= z; k += 1) {
          const encoded = denseIds[(i * r + j) * r + k];
          if (encoded === 0) throw new Error('internal fast modulus point lookup failure');
          ids[index] = encoded - 1;
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
  const characters = new Uint16Array(points.length);
  for (let pointId = 0; pointId < points.length; pointId += 1) {
    const point = points[pointId];
    characters[pointId] = (
      point[0] * residues[0]
      + point[1] * residues[1]
      + point[2] * residues[2]
    ) % r;
  }

  const buckets: FastCandidate[][] = Array.from({ length: r }, () => []);
  // Epoch marking avoids allocating/clearing a length-r seen array for every
  // principal box. The current exact modulus cap keeps the epoch count tiny.
  const seenEpoch = new Uint16Array(r);
  let epoch = 1;

  for (let pointId = 0; pointId < points.length; pointId += 1) {
    if (epoch === 0xffff) {
      seenEpoch.fill(0);
      epoch = 1;
    }
    const currentEpoch = epoch;
    epoch += 1;
    const boxIds = boxPointIds[pointId];
    const assignmentCharacters: number[] = [];
    const assignmentPointIds: number[] = [];
    let valid = true;

    for (let index = 0; index < boxIds.length; index += 1) {
      const assignedPointId = boxIds[index];
      const chi = characters[assignedPointId];
      if (seenEpoch[chi] === currentEpoch) {
        valid = false;
        break;
      }
      seenEpoch[chi] = currentEpoch;
      assignmentCharacters.push(chi);
      assignmentPointIds.push(assignedPointId);
    }

    if (valid) {
      buckets[characters[pointId]].push({
        pointId,
        characters: assignmentCharacters,
        pointIds: assignmentPointIds,
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

/** Stream the exact frozen CSP downsets in the same deterministic emission order. */
export function* iterFastDownsets(
  rInput: number,
  residuesInput: readonly number[],
  options: {
    modulusContext?: FastModulusContext;
    cancelCheck?: CancelCheck;
    metrics?: SearchMetrics;
  } = {},
): Generator<readonly Point[]> {
  assertSupportedModulus(rInput);
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
  // Zero means unassigned; otherwise store pointId+1. Point 0 is (0,0,0).
  const assigned = new Uint16Array(r);
  assigned[0] = 1;
  let assignedCount = 1;

  const compatible = (candidate: FastCandidate): boolean => {
    if (options.metrics) options.metrics.compatibilityChecks += 1;
    for (let index = 0; index < candidate.characters.length; index += 1) {
      const chi = candidate.characters[index];
      const current = assigned[chi];
      const candidatePoint = candidate.pointIds[index] + 1;
      if (current !== 0 && current !== candidatePoint) return false;
    }
    return true;
  };

  const apply = (candidate: FastCandidate): number[] => {
    const added: number[] = [];
    for (let index = 0; index < candidate.characters.length; index += 1) {
      const chi = candidate.characters[index];
      if (assigned[chi] === 0) {
        assigned[chi] = candidate.pointIds[index] + 1;
        added.push(chi);
      }
    }
    assignedCount += added.length;
    return added;
  };

  const undo = (added: readonly number[]): void => {
    for (const chi of added) assigned[chi] = 0;
    assignedCount -= added.length;
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
    const propagated: number[][] = [];
    try {
      while (true) {
        if (assignedCount === r) {
          yield emit();
          return;
        }

        let bestCharacter = -1;
        let bestDomain: FastCandidate[] | null = null;
        for (let chi = 1; chi < r; chi += 1) {
          if (assigned[chi] !== 0) continue;
          const domain: FastCandidate[] = [];
          for (const candidate of candidates[chi]) {
            if (compatible(candidate)) domain.push(candidate);
          }
          if (domain.length === 0) return;
          if (
            bestDomain === null
            || domain.length < bestDomain.length
            || (domain.length === bestDomain.length && chi < bestCharacter)
          ) {
            bestCharacter = chi;
            bestDomain = domain;
          }
          if (domain.length === 1) break;
        }

        if (bestDomain === null) throw new Error('internal fast CSP domain failure');
        if (bestDomain.length === 1) {
          const added = apply(bestDomain[0]);
          propagated.push(added);
          if (options.metrics) options.metrics.singletonPropagations += 1;
          continue;
        }

        if (options.metrics) options.metrics.branches += 1;
        for (const candidate of bestDomain) {
          const added = apply(candidate);
          try {
            yield* search();
          } finally {
            undo(added);
          }
        }
        return;
      }
    } finally {
      for (let index = propagated.length - 1; index >= 0; index -= 1) undo(propagated[index]);
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
  const result = [...iterFastDownsets(r, residues, options)].sort(compareDownsets);
  return result;
}
