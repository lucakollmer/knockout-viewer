import type { DownsetRecord, Point } from './asetsCore';
import { assertExactRuntimeModulus } from './asetsRuntime';

type PackedKey = number | string;

// A dense triangular cache is much faster for the hot low row IDs; cap it at 16 MiB and fall back to the sparse Map beyond that.
const DENSE_PAIR_CACHE_LIMIT_ENTRIES = 4 * 1024 * 1024;

export type FamilyGeometryContext = {
  r: number;
  residues: Point;
  rowOffset: number;
  rowBase: number;
  normalOffset: number;
  normalBase: number;
  rowIds: Map<PackedKey, number>;
  rowPoints: Point[];
  lineIds: Map<PackedKey, number>;
  linePoints: Point[];
  pairLines: Map<PackedKey, number>;
  pairLineDense: Uint32Array;
  quotientScales: number[];
  betaPoints: Array<Point | undefined>;
  characterEpochs: Uint32Array;
  rowEpochs: Uint32Array;
  recordEpoch: number;
  linePositiveWitnesses: number[];
  lineNegativeWitnesses: number[];
  previousRowIds: number[];
  activeRowFlags: Uint8Array;
  linePairCounts: number[];
  activeLineIds: number[];
  activeLinePositions: number[];
  previousCoherentWitness: Point | null;
};

export function createFamilyGeometryContext(r: number, residues: Point): FamilyGeometryContext {
  assertExactRuntimeModulus(r);
  for (const residue of residues) {
    if (!Number.isSafeInteger(residue) || residue < 0 || residue >= r) {
      throw new Error('geometry residues must be normalized safe integers modulo r');
    }
  }
  return {
    r,
    residues,
    rowOffset: r,
    rowBase: 2 * r + 1,
    normalOffset: 2 * r * r + 1,
    normalBase: 4 * r * r + 3,
    rowIds: new Map(),
    rowPoints: [],
    lineIds: new Map(),
    linePoints: [],
    pairLines: new Map(),
    pairLineDense: new Uint32Array(16),
    quotientScales: [],
    betaPoints: new Array<Point | undefined>(r),
    characterEpochs: new Uint32Array(r),
    rowEpochs: new Uint32Array(16),
    recordEpoch: 0,
    linePositiveWitnesses: [],
    lineNegativeWitnesses: [],
    previousRowIds: [],
    activeRowFlags: new Uint8Array(16),
    linePairCounts: [],
    activeLineIds: [],
    activeLinePositions: [],
    previousCoherentWitness: null,
  };
}

function packCoordinates(firstValue: number, secondValue: number, thirdValue: number, offset: number, base: number): PackedKey {
  const first = firstValue + offset;
  const second = secondValue + offset;
  const third = thirdValue + offset;
  const packed = (first * base + second) * base + third;
  return Number.isSafeInteger(packed) ? packed : `${firstValue},${secondValue},${thirdValue}`;
}

function pack(point: Point, offset: number, base: number): PackedKey {
  return packCoordinates(point[0], point[1], point[2], offset, base);
}

function comparePoint(first: Point, second: Point): number {
  return first[0] - second[0] || first[1] - second[1] || first[2] - second[2];
}

function gcd2(first: number, second: number): number {
  let a = first;
  let b = second;
  while (a !== 0) {
    const next = b % a;
    b = a;
    a = next;
  }
  return Math.abs(b);
}

function gcd3(first: number, second: number, third: number): number {
  return gcd2(gcd2(first, second), third);
}

function gcd4(first: number, second: number, third: number, fourth: number): number {
  return gcd2(gcd3(first, second, third), fourth);
}

function ensureEpochCapacity(values: Uint32Array, needed: number): Uint32Array {
  if (needed <= values.length) return values;
  let size = values.length || 16;
  while (size < needed) size *= 2;
  const expanded = new Uint32Array(size);
  expanded.set(values);
  return expanded;
}

function ensureFlagCapacity(values: Uint8Array, needed: number): Uint8Array {
  if (needed <= values.length) return values;
  let size = values.length || 16;
  while (size < needed) size *= 2;
  const expanded = new Uint8Array(size);
  expanded.set(values);
  return expanded;
}

function nextRecordEpoch(context: FamilyGeometryContext): number {
  if (context.recordEpoch >= 0xfffffffe) {
    context.characterEpochs.fill(0);
    context.rowEpochs.fill(0);
    context.recordEpoch = 1;
  } else {
    context.recordEpoch += 1;
  }
  return context.recordEpoch;
}

function registerRowCoordinates(context: FamilyGeometryContext, x: number, y: number, z: number): number {
  const key = packCoordinates(x, y, z, context.rowOffset, context.rowBase);
  const cached = context.rowIds.get(key);
  if (cached !== undefined) return cached;
  const id = context.rowPoints.length;
  context.rowIds.set(key, id);
  context.rowPoints.push([x, y, z]);
  return id;
}

function registerLine(context: FamilyGeometryContext, point: Point): number {
  const key = pack(point, context.normalOffset, context.normalBase);
  const cached = context.lineIds.get(key);
  if (cached !== undefined) return cached;
  const id = context.linePoints.length;
  context.lineIds.set(key, id);
  context.linePoints.push(point);
  context.quotientScales.push(0);
  context.linePositiveWitnesses.push(0);
  context.lineNegativeWitnesses.push(0);
  context.linePairCounts.push(0);
  context.activeLinePositions.push(0);
  return id;
}

function pairKey(low: number, high: number): PackedKey {
  const packed = high * (high + 1) / 2 + low;
  return Number.isSafeInteger(packed) ? packed : `${low}:${high}`;
}

function lineForPair(context: FamilyGeometryContext, firstId: number, secondId: number): number {
  let low = firstId;
  let high = secondId;
  if (low > high) [low, high] = [high, low];
  const key = pairKey(low, high);
  let denseKey = -1;
  if (typeof key === 'number' && key < DENSE_PAIR_CACHE_LIMIT_ENTRIES) {
    denseKey = key;
    if (denseKey >= context.pairLineDense.length) {
      let size = context.pairLineDense.length;
      while (size <= denseKey && size < DENSE_PAIR_CACHE_LIMIT_ENTRIES) size *= 2;
      const expanded = new Uint32Array(Math.min(size, DENSE_PAIR_CACHE_LIMIT_ENTRIES));
      expanded.set(context.pairLineDense);
      context.pairLineDense = expanded;
    }
    const encoded = context.pairLineDense[denseKey];
    if (encoded !== 0) return encoded === 1 ? -1 : encoded - 2;
  } else {
    const cached = context.pairLines.get(key);
    if (cached !== undefined) return cached - 1;
  }
  const first = context.rowPoints[firstId];
  const second = context.rowPoints[secondId];
  const cross: Point = [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
  if (cross[0] === 0 && cross[1] === 0 && cross[2] === 0) {
    if (denseKey >= 0) context.pairLineDense[denseKey] = 1;
    else context.pairLines.set(key, 0);
    return -1;
  }
  const common = gcd3(Math.abs(cross[0]), Math.abs(cross[1]), Math.abs(cross[2]));
  let line: Point = [cross[0] / common, cross[1] / common, cross[2] / common];
  for (const value of line) {
    if (value !== 0) {
      if (value < 0) line = [-line[0], -line[1], -line[2]];
      break;
    }
  }
  const lineId = registerLine(context, line);
  if (denseKey >= 0) context.pairLineDense[denseKey] = lineId + 2;
  else context.pairLines.set(key, lineId + 1);
  return lineId;
}

function quotientScale(context: FamilyGeometryContext, lineId: number): number {
  const cached = context.quotientScales[lineId];
  if (cached !== 0) return cached;
  const ray = context.linePoints[lineId];
  const residues = context.residues;
  const first = residues[0] * ray[1] - residues[1] * ray[0];
  const second = residues[0] * ray[2] - residues[2] * ray[0];
  const third = residues[1] * ray[2] - residues[2] * ray[1];
  const scale = context.r / gcd4(context.r, Math.abs(first), Math.abs(second), Math.abs(third));
  context.quotientScales[lineId] = scale;
  return scale;
}

function markRow(context: FamilyGeometryContext, rowId: number, epoch: number, rowIds: number[]): void {
  context.rowEpochs = ensureEpochCapacity(context.rowEpochs, rowId + 1);
  if (context.rowEpochs[rowId] === epoch) return;
  context.rowEpochs[rowId] = epoch;
  rowIds.push(rowId);
}

type RowsWithIds = { rows: Point[]; rowIds: number[]; epoch: number };

function transitionRowsCached(
  downset: readonly Point[], residues: Point, r: number, context: FamilyGeometryContext,
): RowsWithIds {
  if (downset.length !== r) throw new Error('downset character map is not surjective');
  const epoch = nextRecordEpoch(context);
  const beta = context.betaPoints;
  for (const point of downset) {
    const chi = (point[0] * residues[0] + point[1] * residues[1] + point[2] * residues[2]) % r;
    if (context.characterEpochs[chi] === epoch) throw new Error('downset character map is not injective');
    context.characterEpochs[chi] = epoch;
    beta[chi] = point;
  }

  const rowIds: number[] = [];
  for (let chi = 0; chi < r; chi += 1) {
    const source = beta[chi];
    if (!source) throw new Error('downset character map is not surjective');
    for (let axis = 0; axis < 3; axis += 1) {
      const target = beta[(chi + residues[axis]) % r];
      if (!target) throw new Error('downset character map is not surjective');
      const x = source[0] - target[0] + (axis === 0 ? 1 : 0);
      const y = source[1] - target[1] + (axis === 1 ? 1 : 0);
      const z = source[2] - target[2] + (axis === 2 ? 1 : 0);
      if (x === 0 && y === 0 && z === 0) continue;
      markRow(context, registerRowCoordinates(context, x, y, z), epoch, rowIds);
    }
  }
  rowIds.sort((first, second) => comparePoint(context.rowPoints[first], context.rowPoints[second]));
  return { rows: rowIds.map((rowId) => context.rowPoints[rowId]), rowIds, epoch };
}

type Normal = { lineId: number; sign: 1 | -1; point: Point };
type ProjectedRow = { rowId: number; denominator: number };

function dot(first: Point, second: Point): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function determinant(first: Point, second: Point, third: Point): number {
  return (
    first[0] * (second[1] * third[2] - second[2] * third[1])
    - first[1] * (second[0] * third[2] - second[2] * third[0])
    + first[2] * (second[0] * third[1] - second[1] * third[0])
  );
}

// If the previous exact coherence witness still strictly separates the current
// transition rows, intersect every ray with witness·x=1. Supporting cone facets
// are then exactly the edges of that 2D convex hull. The projected coordinates
// are rational, but comparisons use cross multiplication and orientation uses the
// original integer 3x3 determinant, so this path does not introduce floating-point
// geometry. Degenerate or unsupported cases fall back to the pair-line scanner.
function trySupportingNormalsFromWitness(
  rowIds: readonly number[], context: FamilyGeometryContext, witness: Point,
): Normal[] | null {
  if (rowIds.length < 3) return null;
  let dropAxis = 0;
  if (Math.abs(witness[1]) > Math.abs(witness[dropAxis])) dropAxis = 1;
  if (Math.abs(witness[2]) > Math.abs(witness[dropAxis])) dropAxis = 2;
  if (witness[dropAxis] === 0) return null;
  const projectionAxes: readonly (readonly [number, number])[] = [[1, 2], [2, 0], [0, 1]];
  const [firstAxis, secondAxis] = projectionAxes[dropAxis];
  const projected: ProjectedRow[] = [];
  let maxDenominator = 0;
  let maxCoordinate = 0;

  for (const rowId of rowIds) {
    const row = context.rowPoints[rowId];
    const denominator = dot(row, witness);
    if (denominator <= 0 || !Number.isSafeInteger(denominator)) return null;
    maxDenominator = Math.max(maxDenominator, denominator);
    maxCoordinate = Math.max(maxCoordinate, Math.abs(row[firstAxis]), Math.abs(row[secondAxis]));
    projected.push({ rowId, denominator });
  }
  // The runtime Number-safety proof covers this bound for supported moduli. Keep
  // the optimization fail-closed if a future representation violates it.
  if (!Number.isSafeInteger(2 * maxDenominator * maxCoordinate)) return null;

  const compareProjected = (first: ProjectedRow, second: ProjectedRow): number => {
    const firstRow = context.rowPoints[first.rowId];
    const secondRow = context.rowPoints[second.rowId];
    const firstCoordinate = firstRow[firstAxis] * second.denominator - secondRow[firstAxis] * first.denominator;
    if (firstCoordinate !== 0) return firstCoordinate;
    return firstRow[secondAxis] * second.denominator - secondRow[secondAxis] * first.denominator;
  };
  projected.sort(compareProjected);

  const unique: ProjectedRow[] = [];
  for (const entry of projected) {
    const previous = unique[unique.length - 1];
    if (previous && compareProjected(previous, entry) === 0) continue;
    unique.push(entry);
  }
  if (unique.length < 3) return null;

  const orientationSign = witness[dropAxis] > 0 ? 1 : -1;
  const orientation = (first: ProjectedRow, second: ProjectedRow, third: ProjectedRow): number => (
    orientationSign * determinant(
      context.rowPoints[first.rowId],
      context.rowPoints[second.rowId],
      context.rowPoints[third.rowId],
    )
  );

  const lower: ProjectedRow[] = [];
  for (const entry of unique) {
    while (lower.length >= 2 && orientation(lower[lower.length - 2], lower[lower.length - 1], entry) <= 0) lower.pop();
    lower.push(entry);
  }
  const upper: ProjectedRow[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const entry = unique[index];
    while (upper.length >= 2 && orientation(upper[upper.length - 2], upper[upper.length - 1], entry) <= 0) upper.pop();
    upper.push(entry);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return null;

  const normals: Normal[] = [];
  for (let index = 0; index < hull.length; index += 1) {
    const firstId = hull[index].rowId;
    const secondId = hull[(index + 1) % hull.length].rowId;
    const lineId = lineForPair(context, firstId, secondId);
    if (lineId < 0) return null;
    const line = context.linePoints[lineId];
    let positive = false;
    let negative = false;
    for (const rowId of rowIds) {
      const value = dot(line, context.rowPoints[rowId]);
      if (value > 0) positive = true;
      else if (value < 0) negative = true;
      if (positive && negative) return null;
    }
    if (!negative) normals.push({ lineId, sign: 1, point: line });
    else if (!positive) normals.push({ lineId, sign: -1, point: [-line[0], -line[1], -line[2]] });
    else return null;
  }
  normals.sort((first, second) => comparePoint(first.point, second.point));

  const candidate: [number, number, number] = [0, 0, 0];
  for (const normal of normals) {
    candidate[0] += normal.point[0];
    candidate[1] += normal.point[1];
    candidate[2] += normal.point[2];
  }
  if (!rowIds.every((rowId) => dot(context.rowPoints[rowId], candidate) > 0)) return null;
  return normals;
}

function adjustActiveLinePair(context: FamilyGeometryContext, firstId: number, secondId: number, delta: 1 | -1): void {
  const lineId = lineForPair(context, firstId, secondId);
  if (lineId < 0) return;
  const previous = context.linePairCounts[lineId];
  const next = previous + delta;
  if (next < 0) throw new Error('internal geometry line-pair count underflow');
  context.linePairCounts[lineId] = next;
  if (previous === 0 && next !== 0) {
    context.activeLinePositions[lineId] = context.activeLineIds.length + 1;
    context.activeLineIds.push(lineId);
  } else if (previous !== 0 && next === 0) {
    const position = context.activeLinePositions[lineId] - 1;
    const last = context.activeLineIds.pop();
    if (position < 0 || last === undefined) throw new Error('internal geometry active-line index failure');
    if (position < context.activeLineIds.length) {
      context.activeLineIds[position] = last;
      context.activeLinePositions[last] = position + 1;
    }
    context.activeLinePositions[lineId] = 0;
  }
}

// Consecutive CSP emissions differ by only a few transition rows. Maintain the exact
// candidate-line multiset by adding/removing only pairs touched by those row changes.
function syncActiveLines(rowIds: readonly number[], context: FamilyGeometryContext, epoch: number): void {
  const maxRowId = rowIds.reduce((maximum, rowId) => Math.max(maximum, rowId), -1);
  context.activeRowFlags = ensureFlagCapacity(context.activeRowFlags, maxRowId + 1);
  const previous = context.previousRowIds;
  if (previous.length === 0) {
    for (let first = 0; first < rowIds.length; first += 1) {
      for (let second = first + 1; second < rowIds.length; second += 1) {
        adjustActiveLinePair(context, rowIds[first], rowIds[second], 1);
      }
    }
    for (const rowId of rowIds) context.activeRowFlags[rowId] = 1;
    context.previousRowIds = [...rowIds];
    return;
  }

  for (const removed of previous) {
    if (context.rowEpochs[removed] === epoch) continue;
    for (const other of previous) {
      if (other === removed) continue;
      const otherRemoved = context.rowEpochs[other] !== epoch;
      if (!otherRemoved || removed < other) adjustActiveLinePair(context, removed, other, -1);
    }
  }
  for (const added of rowIds) {
    if (context.activeRowFlags[added] !== 0) continue;
    for (const other of rowIds) {
      if (other === added) continue;
      const otherAdded = context.activeRowFlags[other] === 0;
      if (!otherAdded || added < other) adjustActiveLinePair(context, added, other, 1);
    }
  }
  for (const removed of previous) if (context.rowEpochs[removed] !== epoch) context.activeRowFlags[removed] = 0;
  for (const added of rowIds) context.activeRowFlags[added] = 1;
  context.previousRowIds = [...rowIds];
}

function supportingNormalsCached(rowIds: readonly number[], context: FamilyGeometryContext, epoch: number): Normal[] {
  const previousWitness = context.previousCoherentWitness;
  if (previousWitness) {
    const hullNormals = trySupportingNormalsFromWitness(rowIds, context, previousWitness);
    if (hullNormals) return hullNormals;
  }

  syncActiveLines(rowIds, context, epoch);
  const normals: Normal[] = [];
  for (let activeIndex = 0; activeIndex < context.activeLineIds.length; activeIndex += 1) {
    const lineId = context.activeLineIds[activeIndex];
    const previousPositive = context.linePositiveWitnesses[lineId];
    const previousNegative = context.lineNegativeWitnesses[lineId];
    // A remembered sign witness is globally valid for this line. If one side is
    // still present, seed the scan with it and search only for the missing side.
    let positive = previousPositive !== 0 && context.rowEpochs[previousPositive - 1] === epoch ? previousPositive : 0;
    let negative = previousNegative !== 0 && context.rowEpochs[previousNegative - 1] === epoch ? previousNegative : 0;
    if (positive !== 0 && negative !== 0) continue;
    let mixed = false;
    const line = context.linePoints[lineId];
    for (const rowId of rowIds) {
      const row = context.rowPoints[rowId];
      const value = line[0] * row[0] + line[1] * row[1] + line[2] * row[2];
      if (value > 0 && positive === 0) positive = rowId + 1;
      else if (value < 0 && negative === 0) negative = rowId + 1;
      if (positive !== 0 && negative !== 0) {
        context.linePositiveWitnesses[lineId] = positive;
        context.lineNegativeWitnesses[lineId] = negative;
        mixed = true;
        break;
      }
    }
    if (mixed) continue;
    if (positive !== 0) context.linePositiveWitnesses[lineId] = positive;
    if (negative !== 0) context.lineNegativeWitnesses[lineId] = negative;
    if (negative === 0) normals.push({ lineId, sign: 1, point: line });
    else if (positive === 0) normals.push({ lineId, sign: -1, point: [-line[0], -line[1], -line[2]] });
  }
  normals.sort((first, second) => comparePoint(first.point, second.point));
  return normals;
}

export function geometryRecordCached(
  downset: readonly Point[], residues: Point, r: number, context: FamilyGeometryContext,
): DownsetRecord {
  if (context.r !== r || context.residues.some((value, axis) => value !== residues[axis])) {
    throw new Error('family geometry context does not match r/residues');
  }
  const { rows, rowIds, epoch } = transitionRowsCached(downset, residues, r, context);
  const normals = supportingNormalsCached(rowIds, context, epoch);

  let coherent = false;
  let witness: Point | null = null;
  if (normals.length !== 0) {
    const candidate: [number, number, number] = [0, 0, 0];
    for (const normal of normals) {
      candidate[0] += normal.point[0];
      candidate[1] += normal.point[1];
      candidate[2] += normal.point[2];
    }
    if (rowIds.every((rowId) => {
      const row = context.rowPoints[rowId];
      return row[0] * candidate[0] + row[1] * candidate[1] + row[2] * candidate[2] > 0;
    })) {
      coherent = true;
      witness = candidate;
    }
  }
  context.previousCoherentWitness = coherent ? witness : null;

  let activeMask = 0;
  for (const point of downset) {
    if (point[0] !== 0) activeMask |= 1;
    if (point[1] !== 0) activeMask |= 2;
    if (point[2] !== 0) activeMask |= 4;
  }
  const activeAxes: number[] = [];
  const inactiveAxes: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) (((activeMask >> axis) & 1) ? activeAxes : inactiveAxes).push(axis);

  const lowRays: Point[] = [];
  if (coherent) {
    for (const normal of normals) {
      const inactiveBasis = inactiveAxes.some((axis) => (
        normal.point[0] === (axis === 0 ? 1 : 0)
        && normal.point[1] === (axis === 1 ? 1 : 0)
        && normal.point[2] === (axis === 2 ? 1 : 0)
      ));
      if (inactiveBasis) continue;
      const scale = quotientScale(context, normal.lineId);
      const line = context.linePoints[normal.lineId];
      lowRays.push([scale * normal.sign * line[0], scale * normal.sign * line[1], scale * normal.sign * line[2]]);
    }
    lowRays.sort(comparePoint);
  }

  const vertexCount = lowRays.length + inactiveAxes.length;
  const shape: DownsetRecord['shape'] = !coherent
    ? 'noncoherent'
    : vertexCount === 3 ? 'triangle' : vertexCount === 4 ? 'quadrilateral' : 'polygon';
  return { downset, transitionRows: rows, coherent, witness, activeAxes, inactiveAxes, shape, lowRays };
}
