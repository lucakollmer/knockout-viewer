import { transportRecordToPresentation, type DownsetRecord, type FamilyTransformCertificate, type Point } from './asetsCore';
import type { GroupRow } from './groupMath';

export type LegacyViewerRecord = {
  index: number;
  points: number[][];
  coherent: boolean;
  coherence_witness: number[] | null;
  positive_circuit: null;
};

export type LegacyViewerResult = {
  affine_pieces: null;
  terminal_downsets: number;
  coherent_downsets: number;
  noncoherent_downsets: number;
  points: number[][];
  cones: number[][][];
  adjacency: number[][];
  surface_polygons: number[][];
  discrepancies: never[];
  block_count: 3;
  expected_point_count: number;
  expected_adjacency_edge_count: number;
};

export type LegacyViewerData = {
  requested_group: number[];
  stored_group: number[];
  equivalence: {
    canonicalized: boolean;
    non_effective_reduced: boolean;
    input_r: number;
    effective_r: number;
  };
  group_id: string;
  family_id: null;
  block_count: 3;
  support_size: number;
  representation: Array<[number, number]>;
  navigation: null;
  result: LegacyViewerResult;
  collapsed_residues: number[];
  collapsed_asets: LegacyViewerRecord[];
  family_residues: number[];
  family_to_group: number[];
};

function pointKey(point: readonly number[]): string {
  return point.map((value) => Number(value).toPrecision(15)).join(',');
}

function comparePoint(left: readonly number[], right: readonly number[]): number {
  for (let axis = 0; axis < 3; axis += 1) {
    if (left[axis] !== right[axis]) return left[axis] < right[axis] ? -1 : 1;
  }
  return 0;
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function norm(vector: readonly number[]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

/** Reproduces the old viewer's cyclic polygon ordering for quadrilateral cones. */
export function orderLegacyPolygon(input: readonly (readonly number[])[]): number[][] {
  const clean: number[][] = [];
  const seen = new Set<string>();
  for (const point of input) {
    const copy = [Number(point[0]), Number(point[1]), Number(point[2])];
    const key = pointKey(copy);
    if (!seen.has(key)) {
      seen.add(key);
      clean.push(copy);
    }
  }
  if (clean.length <= 3) return clean;

  const center = [0, 1, 2].map((axis) => clean.reduce((sum, point) => sum + point[axis], 0) / clean.length);
  let u: number[] | null = null;
  for (const point of clean) {
    const delta = point.map((value, axis) => value - center[axis]);
    const length = norm(delta);
    if (length > 1e-12) {
      u = delta.map((value) => value / length);
      break;
    }
  }
  if (!u) return clean;

  let normal: number[] | null = null;
  for (const point of clean) {
    const delta = point.map((value, axis) => value - center[axis]);
    const candidate = cross(u, delta);
    const length = norm(candidate);
    if (length > 1e-10) {
      normal = candidate.map((value) => value / length);
      break;
    }
  }
  if (!normal) return clean;
  const v = cross(normal, u);

  return clean
    .map((point) => {
      const delta = point.map((value, axis) => value - center[axis]);
      return { angle: Math.atan2(dot(delta, v), dot(delta, u)), point };
    })
    .sort((left, right) => left.angle - right.angle)
    .map(({ point }) => point);
}

function representationFor(group: GroupRow): Array<[number, number]> {
  const counts = new Map<number, number>();
  for (const [multiplicity, residue] of [
    [group.n, group.a],
    [group.m, group.b],
    [group.k, group.c],
  ] as const) {
    counts.set(residue, (counts.get(residue) ?? 0) + multiplicity);
  }
  return [...counts.entries()].sort((left, right) => left[0] - right[0]);
}

export function makeLegacyViewerData(
  group: GroupRow,
  canonicalRecords: readonly DownsetRecord[],
  certificate: FamilyTransformCertificate,
): LegacyViewerData {
  const records = canonicalRecords.map((record) => transportRecordToPresentation(record, certificate));
  const formal: number[][] = [
    [group.r / group.n, 0, 0],
    [0, group.r / group.m, 0],
    [0, 0, group.r / group.k],
  ];

  const pointMap = new Map<string, number[]>();
  const insertPoint = (point: readonly number[]): void => {
    const normalized = [Number(point[0]), Number(point[1]), Number(point[2])];
    pointMap.set(pointKey(normalized), normalized);
  };
  for (const point of formal) insertPoint(point);

  const cones = records.map((record) => {
    const vertices: number[][] = [];
    for (const axis of record.inactiveAxes) vertices.push([...formal[axis]]);
    for (const ray of record.lowRays) vertices.push([ray[0], ray[1], ray[2]]);
    const ordered = orderLegacyPolygon(vertices);
    for (const point of ordered) insertPoint(point);
    return ordered;
  });

  // Preserve the old viewer's stable order: formal C/D/E intercepts first,
  // followed by all other points lexicographically.
  const points: number[][] = [];
  const emitted = new Set<string>();
  for (const point of formal) {
    const key = pointKey(point);
    if (!emitted.has(key)) {
      emitted.add(key);
      points.push([...point]);
    }
  }
  const remaining = [...pointMap.values()]
    .filter((point) => !emitted.has(pointKey(point)))
    .sort(comparePoint);
  for (const point of remaining) points.push([...point]);

  const index = new Map(points.map((point, pointIndex) => [pointKey(point), pointIndex] as const));
  const adjacency = Array.from({ length: points.length }, () => Array<number>(points.length).fill(0));
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    adjacency[pointIndex][pointIndex] = (group.n * point[0] + group.m * point[1] + group.k * point[2]) / group.r;
  }

  const edges = new Set<string>();
  const addEdge = (left: number, right: number): void => {
    const a = Math.min(left, right);
    const b = Math.max(left, right);
    const key = `${a}:${b}`;
    if (edges.has(key)) return;
    edges.add(key);
    adjacency[a][b] = adjacency[b][a] = 1;
  };

  const surfacePolygons: number[][] = [];
  for (const cone of cones) {
    const ids = cone.map((point) => {
      const value = index.get(pointKey(point));
      if (value === undefined) throw new Error(`legacy viewer point missing: ${point.join(',')}`);
      return value;
    });
    if (ids.length >= 3) {
      surfacePolygons.push(ids);
      for (let i = 0; i < ids.length; i += 1) addEdge(ids[i], ids[(i + 1) % ids.length]);
    } else if (ids.length === 2) {
      addEdge(ids[0], ids[1]);
    }
  }

  const coherentTotal = records.filter((record) => record.coherent).length;
  const collapsedAsets: LegacyViewerRecord[] = records.map((record, indexValue) => ({
    index: indexValue,
    points: record.downset.map((point: Point) => [point[0], point[1], point[2]]),
    coherent: record.coherent,
    coherence_witness: record.witness === null ? null : [...record.witness],
    positive_circuit: null,
  }));
  const representation = representationFor(group);

  return {
    requested_group: [group.d, group.r, group.n, group.m, group.k, group.a, group.b, group.c],
    stored_group: [group.d, group.r, group.n, group.m, group.k, group.a, group.b, group.c],
    equivalence: {
      canonicalized: false,
      non_effective_reduced: certificate.effectiveCommonFactor !== 1,
      input_r: certificate.originalModulus,
      effective_r: certificate.effectiveModulus,
    },
    group_id: group.id,
    family_id: null,
    block_count: 3,
    support_size: representation.length,
    representation,
    navigation: null,
    result: {
      affine_pieces: null,
      terminal_downsets: records.length,
      coherent_downsets: coherentTotal,
      noncoherent_downsets: records.length - coherentTotal,
      points,
      cones,
      adjacency,
      surface_polygons: surfacePolygons,
      discrepancies: [],
      block_count: 3,
      expected_point_count: points.length,
      expected_adjacency_edge_count: edges.size,
    },
    collapsed_residues: [group.a, group.b, group.c],
    collapsed_asets: collapsedAsets,
    family_residues: [...certificate.canonicalResidues],
    family_to_group: [...certificate.axisPermutation],
  };
}
