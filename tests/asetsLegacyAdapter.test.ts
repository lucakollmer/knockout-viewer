import { describe, expect, it } from 'vitest';
import type { DownsetRecord, FamilyTransformCertificate } from '../src/asetsCore';
import { makeLegacyViewerData } from '../src/asetsLegacyAdapter';
import type { GroupRow } from '../src/groupMath';

const CANONICAL_ZERO_ONE_ONE_RECORDS_R2: readonly DownsetRecord[] = [
  {
    downset: [[0, 0, 0], [0, 0, 1]],
    transitionRows: [],
    coherent: true,
    witness: [1, 2, 1],
    activeAxes: [2],
    inactiveAxes: [0, 1],
    shape: 'triangle',
    lowRays: [[0, 1, 1]],
  },
  {
    downset: [[0, 0, 0], [0, 1, 0]],
    transitionRows: [],
    coherent: true,
    witness: [1, 1, 2],
    activeAxes: [1],
    inactiveAxes: [0, 2],
    shape: 'triangle',
    lowRays: [[0, 1, 1]],
  },
];

const CANONICAL_ZERO_ONE_ONE_RECORDS_R3: readonly DownsetRecord[] = [
  {
    downset: [[0, 0, 0], [0, 0, 1], [0, 0, 2]],
    transitionRows: [],
    coherent: true,
    witness: [2, 1, 1],
    activeAxes: [2],
    inactiveAxes: [0, 1],
    shape: 'triangle',
    lowRays: [[0, 1, 1]],
  },
  {
    downset: [[0, 0, 0], [0, 1, 0], [0, 2, 0]],
    transitionRows: [],
    coherent: true,
    witness: [1, 1, 2],
    activeAxes: [1],
    inactiveAxes: [0, 2],
    shape: 'triangle',
    lowRays: [[0, 1, 1]],
  },
];

const IDENTITY_R2: FamilyTransformCertificate = {
  originalModulus: 2,
  originalResidues: [0, 1, 1],
  effectiveCommonFactor: 1,
  effectiveModulus: 2,
  reducedResidues: [0, 1, 1],
  canonicalResidues: [0, 1, 1],
  axisPermutation: [0, 1, 2],
  inverseAxisPermutation: [0, 1, 2],
  unitMultiplier: 1,
  unitInverse: 1,
};

const SWAP_C_D_R3: FamilyTransformCertificate = {
  originalModulus: 3,
  originalResidues: [1, 0, 1],
  effectiveCommonFactor: 1,
  effectiveModulus: 3,
  reducedResidues: [1, 0, 1],
  canonicalResidues: [0, 1, 1],
  axisPermutation: [1, 0, 2],
  inverseAxisPermutation: [1, 0, 2],
  unitMultiplier: 1,
  unitInverse: 1,
};

function group(
  d: number,
  r: number,
  n: number,
  m: number,
  k: number,
  a: number,
  b: number,
  c: number,
): GroupRow {
  return { id: `${d}:${r}:${n}:${m}:${k}:${a}:${b}:${c}`, d, r, n, m, k, a, b, c };
}

function edgeCount(adjacency: readonly (readonly number[])[]): number {
  let total = 0;
  for (let i = 0; i < adjacency.length; i += 1) {
    for (let j = i + 1; j < adjacency.length; j += 1) if (adjacency[i][j] !== 0) total += 1;
  }
  return total;
}

describe('v0.3.10 viewer adapter contract', () => {
  it('reproduces the supplied d=4 r=2 reference geometry from fixed engine records', () => {
    const data = makeLegacyViewerData(
      group(4, 2, 2, 1, 1, 0, 1, 1),
      CANONICAL_ZERO_ONE_ONE_RECORDS_R2,
      IDENTITY_R2,
    );

    expect(data.result.points).toEqual([
      [1, 0, 0],
      [0, 2, 0],
      [0, 0, 2],
      [0, 1, 1],
    ]);
    expect(data.result.surface_polygons).toHaveLength(2);
    expect(edgeCount(data.result.adjacency)).toBe(5);
    expect(data.collapsed_asets.map((record) => record.points)).toEqual([
      [[0, 0, 0], [0, 0, 1]],
      [[0, 0, 0], [0, 1, 0]],
    ]);
  });

  it('transports the canonical family into the supplied nontrivial C/D presentation', () => {
    const data = makeLegacyViewerData(
      group(4, 3, 2, 1, 1, 1, 0, 1),
      CANONICAL_ZERO_ONE_ONE_RECORDS_R3,
      SWAP_C_D_R3,
    );

    expect(data.family_to_group).toEqual([1, 0, 2]);
    expect(data.result.points).toEqual([
      [1.5, 0, 0],
      [0, 3, 0],
      [0, 0, 3],
      [1, 0, 1],
    ]);
    expect(data.result.surface_polygons).toHaveLength(2);
    expect(edgeCount(data.result.adjacency)).toBe(5);
    expect(data.collapsed_asets.map((record) => record.points)).toEqual([
      [[0, 0, 0], [0, 0, 1], [0, 0, 2]],
      [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
    ]);
  });
});
