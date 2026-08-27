import { describe, expect, it } from 'vitest';
import { effectiveFamily, type DownsetRecord } from '../src/asetsCore';
import { buildFastModulusContext, iterFastDownsets } from '../src/asetsFast';
import { createFamilyGeometryContext, geometryRecordCached } from '../src/asetsGeometry';
import { makeLegacyViewerData } from '../src/asetsLegacyAdapter';
import type { GroupRow } from '../src/groupMath';

function computeViewer(group: GroupRow) {
  const normalized = effectiveFamily(group.r, [group.a, group.b, group.c]);
  const modulusContext = buildFastModulusContext(normalized.r);
  const geometryContext = createFamilyGeometryContext(normalized.r, normalized.residues);
  const records: DownsetRecord[] = [];
  for (const downset of iterFastDownsets(normalized.r, normalized.residues, { modulusContext })) {
    records.push(geometryRecordCached(downset, normalized.residues, normalized.r, geometryContext));
  }
  return makeLegacyViewerData(group, records, normalized.certificate);
}

function row(d: number, r: number, n: number, m: number, k: number, a: number, b: number, c: number): GroupRow {
  return { id: `${d}:${r}:${n}:${m}:${k}:${a}:${b}:${c}`, d, r, n, m, k, a, b, c };
}

function edgeCount(adjacency: readonly (readonly number[])[]): number {
  let total = 0;
  for (let i = 0; i < adjacency.length; i += 1) {
    for (let j = i + 1; j < adjacency.length; j += 1) if (adjacency[i][j] !== 0) total += 1;
  }
  return total;
}

describe('v0.3.10 legacy viewer adapter', () => {
  it('reproduces the stored d=4 r=2 reference geometry', () => {
    const data = computeViewer(row(4, 2, 2, 1, 1, 0, 1, 1));
    expect(data.result.terminal_downsets).toBe(2);
    expect(data.result.points).toEqual([
      [1, 0, 0],
      [0, 2, 0],
      [0, 0, 2],
      [0, 1, 1],
    ]);
    expect(edgeCount(data.result.adjacency)).toBe(5);
    expect(data.result.surface_polygons).toHaveLength(2);
    expect(data.collapsed_asets).toHaveLength(2);
  });

  it('preserves a nontrivial family-to-presentation axis permutation', () => {
    const data = computeViewer(row(4, 3, 2, 1, 1, 1, 0, 1));
    expect(data.result.terminal_downsets).toBe(2);
    expect(data.result.points).toEqual([
      [1.5, 0, 0],
      [0, 3, 0],
      [0, 0, 3],
      [1, 0, 1],
    ]);
    expect(edgeCount(data.result.adjacency)).toBe(5);
    expect(data.result.surface_polygons).toHaveLength(2);
  });

  it('reproduces a five-cone repeated-residue reference geometry', () => {
    const data = computeViewer(row(4, 3, 2, 1, 1, 1, 2, 2));
    expect(data.result.terminal_downsets).toBe(5);
    expect(data.result.points).toEqual([
      [1.5, 0, 0],
      [0, 3, 0],
      [0, 0, 3],
      [1, 2, 2],
      [2, 1, 1],
    ]);
    expect(edgeCount(data.result.adjacency)).toBe(9);
    expect(data.result.surface_polygons).toHaveLength(5);
    expect(data.collapsed_residues).toEqual([1, 2, 2]);
  });
});
