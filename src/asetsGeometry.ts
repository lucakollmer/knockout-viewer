import { assertSupportedModulus, type DownsetRecord, type Point } from './asetsCore';

/** Family-local exact geometry reuse for one clicked Aset family. */
export type FamilyGeometryContext = {
  r: number;
  residues: Point;
  rowOffset: number;
  rowBase: number;
  normalOffset: number;
  normalBase: number;
  rowIds: Map<number, number>;
  rowPoints: Point[];
  lineIds: Map<number, number>;
  linePoints: Point[];
  pairLines: Map<number, number>;
  quotientScales: number[];
};

export function createFamilyGeometryContext(r: number, residues: Point): FamilyGeometryContext {
  assertSupportedModulus(r);
  for (const residue of residues) {
    if (!Number.isSafeInteger(residue) || residue < 0 || residue >= r) {
      throw new Error('geometry residues must be normalized safe integers modulo r');
    }
  }
  const normalBase = 4 * r * r + 3;
  if (!Number.isSafeInteger(normalBase ** 3)) throw new Error('geometry packed-key bound exceeds Number safe integers');
  return {
    r,
    residues,
    rowOffset: r,
    rowBase: 2 * r + 1,
    normalOffset: 2 * r * r + 1,
    normalBase,
    rowIds: new Map(),
    rowPoints: [],
    lineIds: new Map(),
    linePoints: [],
    pairLines: new Map(),
    quotientScales: [],
  };
}

function pack(point: Point, offset: number, base: number): number {
  return ((point[0] + offset) * base + point[1] + offset) * base + point[2] + offset;
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

function rowKey(context: FamilyGeometryContext, point: Point): number {
  return pack(point, context.rowOffset, context.rowBase);
}

function registerRow(context: FamilyGeometryContext, point: Point): number {
  const key = rowKey(context, point);
  const cached = context.rowIds.get(key);
  if (cached !== undefined) return cached;
  const id = context.rowPoints.length;
  context.rowIds.set(key, id);
  context.rowPoints.push(point);
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
  return id;
}

function lineForPair(context: FamilyGeometryContext, firstId: number, secondId: number): number {
  let low = firstId;
  let high = secondId;
  if (low > high) [low, high] = [high, low];
  const pairKey = high * (high + 1) / 2 + low;
  const cached = context.pairLines.get(pairKey);
  if (cached !== undefined) return cached - 1;

  const first = context.rowPoints[firstId];
  const second = context.rowPoints[secondId];
  const cross: Point = [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
  if (cross[0] === 0 && cross[1] === 0 && cross[2] === 0) {
    context.pairLines.set(pairKey, 0);
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
  context.pairLines.set(pairKey, lineId + 1);
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

type RowsWithIds = { rows: Point[]; rowIds: number[] };

function transitionRowsCached(
  downset: readonly Point[], residues: Point, r: number, context: FamilyGeometryContext,
): RowsWithIds {
  const beta: Array<Point | null> = Array.from({ length: r }, () => null);
  for (const point of downset) {
    const chi = (point[0] * residues[0] + point[1] * residues[1] + point[2] * residues[2]) % r;
    if (beta[chi] !== null) throw new Error('downset character map is not injective');
    beta[chi] = point;
  }
  if (beta.some((point) => point === null)) throw new Error('downset character map is not surjective');

  const unique = new Map<number, Point>();
  for (let chi = 0; chi < r; chi += 1) {
    const source = beta[chi] as Point;
    for (let axis = 0; axis < 3; axis += 1) {
      const target = beta[(chi + residues[axis]) % r] as Point;
      const row: Point = [
        source[0] - target[0] + (axis === 0 ? 1 : 0),
        source[1] - target[1] + (axis === 1 ? 1 : 0),
        source[2] - target[2] + (axis === 2 ? 1 : 0),
      ];
      if (row[0] !== 0 || row[1] !== 0 || row[2] !== 0) unique.set(rowKey(context, row), row);
    }
  }
  const rows = [...unique.values()].sort(comparePoint);
  return { rows, rowIds: rows.map((row) => registerRow(context, row)) };
}

type Normal = { lineId: number; sign: 1 | -1; point: Point };

function supportingNormalsCached(rowIds: readonly number[], context: FamilyGeometryContext): Normal[] {
  const lineIds = new Set<number>();
  for (let first = 0; first < rowIds.length; first += 1) {
    for (let second = first + 1; second < rowIds.length; second += 1) {
      const lineId = lineForPair(context, rowIds[first], rowIds[second]);
      if (lineId >= 0) lineIds.add(lineId);
    }
  }
  const normals: Normal[] = [];
  for (const lineId of lineIds) {
    const line = context.linePoints[lineId];
    let nonnegative = true;
    let nonpositive = true;
    for (const rowId of rowIds) {
      const row = context.rowPoints[rowId];
      const value = line[0] * row[0] + line[1] * row[1] + line[2] * row[2];
      if (value < 0) nonnegative = false;
      if (value > 0) nonpositive = false;
      if (!nonnegative && !nonpositive) break;
    }
    if (nonnegative) normals.push({ lineId, sign: 1, point: line });
    else if (nonpositive) normals.push({ lineId, sign: -1, point: [-line[0], -line[1], -line[2]] });
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
  const { rows, rowIds } = transitionRowsCached(downset, residues, r, context);
  const normals = supportingNormalsCached(rowIds, context);

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
