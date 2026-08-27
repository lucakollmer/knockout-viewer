import { describe, expect, it } from 'vitest';
import {
  buildModulusContext,
  computeFamily,
  effectiveFamily,
  enumerateDownsets,
  type FamilyResult,
  type Point,
} from '../src/asetsCore';
import { createFamilyGeometryContext, geometryRecordCached } from '../src/asetsGeometry';

function computeCached(r: number, residues: Point): FamilyResult {
  const normalized = effectiveFamily(r, residues);
  const modulusContext = buildModulusContext(normalized.r);
  const downsets = enumerateDownsets(normalized.r, normalized.residues, { modulusContext });
  const geometryContext = createFamilyGeometryContext(normalized.r, normalized.residues);
  return {
    r: normalized.r,
    residues: normalized.residues,
    records: downsets.map((downset) => geometryRecordCached(downset, normalized.residues, normalized.r, geometryContext)),
  };
}

const EXACT_CASES: ReadonlyArray<readonly [number, Point]> = [
  [4, [1, 2, 3]],
  [9, [0, 1, 8]],
  [14, [1, 9, 11]],
  [50, [1, 13, 37]],
  [50, [1, 24, 49]],
];

describe('family-local cached exact geometry', () => {
  it.each(EXACT_CASES)('matches the frozen geometry for r=%i residues=%j', (r, residues) => {
    expect(computeCached(r, residues)).toEqual(computeFamily(r, residues));
  });

  it('rejects reuse across different families', () => {
    const context = createFamilyGeometryContext(14, [1, 9, 11]);
    const other = computeFamily(14, [1, 3, 10]).records[0];
    expect(() => geometryRecordCached(other.downset, [1, 3, 10], 14, context)).toThrow(/does not match/);
  });
});
