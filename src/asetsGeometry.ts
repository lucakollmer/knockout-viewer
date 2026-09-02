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
  linePositiveCounts: number[];
  lineNegativeCounts: number[];
  lineRefreshEpochs: Uint32Array;
  previousRowIds: number[];
  activeRowFlags: Uint8Array;
  linePairCounts: number[];
  activeLineIds: Set<number>;
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
    linePositiveCounts: [],
    lineNegativeCounts: [],
    lineRefreshEpochs: new Uint32Array(16),
    previousRowIds: [],
    activeRowFlags: new Uint8Array(16),
    linePairCounts: [],
    activeLineIds: new Set(),
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
    context.lineRefreshEpochs.fill(0);
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
  context.linePositiveCounts.push(0);
  context.lineNegativeCounts.push(0);
  context.linePairCounts.push(0);
  context.lineRefreshEpochs = ensureEpochCapacity(context.lineRefreshEpochs, id + 1);
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
type RowDelta = { addedRowIds: number[]; removedRowIds: number[] };

function adjustActiveLinePair(
  context: FamilyGeometryContext, firstId: number, secondId: number, delta: 1 | -1, epoch: number,
): void {
  const lineId = lineForPair(context, firstId, secondId);
  if (lineId < 0) return;
  const previous = context.linePairCounts[lineId];
  const next = previous + delta;
  if (next < 0) throw new Error('internal geometry line-pair count underflow');
  context.linePairCounts[lineId] = next;
  if (previous === 0 && next !== 0) {
    context.lineRefreshEpochs = ensureEpochCapacity(context.lineRefreshEpochs, lineId + 1);
    context.lineRefreshEpochs[lineId] = epoch;
    context.activeLineIds.add(lineId);
  } else if (previous !== 0 && next === 0) {
    context.activeLineIds.delete(lineId);
  }
}

// Consecutive CSP emissions differ by only a few transition rows. Maintain the exact
// candidate-line multiset by adding/removing only pairs touched by those row changes.
function syncActiveLines(rowIds: readonly number[], context: FamilyGeometryContext, epoch: number): RowDelta {
  const maxRowId = rowIds.reduce((maximum, rowId) => Math.max(maximum, rowId), -1);
  context.activeRowFlags = ensureFlagCapacity(context.activeRowFlags, maxRowId + 1);
  const previous = context.previousRowIds;
  if (previous.length === 0) {
    for (let first = 0; first < rowIds.length; first += 1) {
      for (let second = first + 1; second < rowIds.length; second += 1) {
        adjustActiveLinePair(context, rowIds[first], rowIds[second], 1, epoch);
      }
    }
    for (const rowId of rowIds) context.activeRowFlags[rowId] = 1;
    context.previousRowIds = [...rowIds];
    return { addedRowIds: [...rowIds], removedRowIds: [] };
  }

  const removedRowIds: number[] = [];
  for (const rowId of previous) {
    if (context.rowEpochs[rowId] !== epoch) removedRowIds.push(rowId);
  }
  const addedRowIds: number[] = [];
  for (const rowId of rowIds) {
    if (context.activeRowFlags[rowId] === 0) addedRowIds.push(rowId);
  }

  for (const removed of removedRowIds) {
    for (const other of previous) {
      if (other === removed) continue;
      const otherRemoved = context.rowEpochs[other] !== epoch;
      if (!otherRemoved || removed < other) adjustActiveLinePair(context, removed, other, -1, epoch);
    }
  }
  for (const added of addedRowIds) {
    for (const other of rowIds) {
      if (other === added) continue;
      const otherAdded = context.activeRowFlags[other] === 0;
      if (!otherAdded || added < other) adjustActiveLinePair(context, added, other, 1, epoch);
    }
  }
  for (const removed of removedRowIds) context.activeRowFlags[removed] = 0;
  for (const added of addedRowIds) context.activeRowFlags[added] = 1;
  context.previousRowIds = [...rowIds];
  return { addedRowIds, removedRowIds };
}

function rowSign(line: Point, row: Point): -1 | 0 | 1 {
  const value = line[0] * row[0] + line[1] * row[1] + line[2] * row[2];
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function supportingNormalsCached(rowIds: readonly number[], context: FamilyGeometryContext, epoch: number): Normal[] {
  const { addedRowIds, removedRowIds } = syncActiveLines(rowIds, context, epoch);
  const normals: Normal[] = [];
  for (const lineId of context.activeLineIds) {
    const line = context.linePoints[lineId];
    let positive = context.linePositiveCounts[lineId];
    let negative = context.lineNegativeCounts[lineId];

    if (context.lineRefreshEpochs[lineId] === epoch) {
      positive = 0;
      negative = 0;
      for (const rowId of rowIds) {
        const sign = rowSign(line, context.rowPoints[rowId]);
        if (sign > 0) positive += 1;
        else if (sign < 0) negative += 1;
      }
    } else {
      for (const rowId of removedRowIds) {
        const sign = rowSign(line, context.rowPoints[rowId]);
        if (sign > 0) positive -= 1;
        else if (sign < 0) negative -= 1;
      }
      for (const rowId of addedRowIds) {
        const sign = rowSign(line, context.rowPoints[rowId]);
        if (sign > 0) positive += 1;
        else if (sign < 0) negative += 1;
      }
      if (positive < 0 || negative < 0) throw new Error('internal geometry line-sign count underflow');
    }

    context.linePositiveCounts[lineId] = positive;
    context.lineNegativeCounts[lineId] = negative;
    if (positive !== 0 && negative !== 0) continue;
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
