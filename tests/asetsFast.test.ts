import { describe, expect, it } from 'vitest';
import {
  compareDownsets,
  computeFamily,
  effectiveFamily,
  type FamilyResult,
  type Point,
} from '../src/asetsCore';
import { buildFastModulusContext, iterFastDownsets } from '../src/asetsFast';
import { createFamilyGeometryContext, geometryRecordCached } from '../src/asetsGeometry';

function computeInteractive(r: number, residues: Point): FamilyResult {
  const normalized = effectiveFamily(r, residues);
  const modulusContext = buildFastModulusContext(normalized.r);
  const downsets = [...iterFastDownsets(normalized.r, normalized.residues, { modulusContext })]
    .sort(compareDownsets);
  const geometryContext = createFamilyGeometryContext(normalized.r, normalized.residues);
  return {
    r: normalized.r,
    residues: normalized.residues,
    records: downsets.map((downset) => geometryRecordCached(
      downset,
      normalized.residues,
      normalized.r,
      geometryContext,
    )),
  };
}

describe('interactive optimized Asets path', () => {
  it('matches the frozen small family', () => {
    const residues: Point = [1, 2, 3];
    expect(computeInteractive(4, residues)).toEqual(computeFamily(4, residues));
  });

  it('matches a nontrivial family with zero residue', () => {
    const residues: Point = [0, 1, 8];
    expect(computeInteractive(9, residues)).toEqual(computeFamily(9, residues));
  });

  it('matches the frozen noncoherent sentinel family', () => {
    const residues: Point = [1, 9, 11];
    expect(computeInteractive(14, residues)).toEqual(computeFamily(14, residues));
  });

  it('matches hard r=50 family 12309', () => {
    const residues: Point = [1, 13, 37];
    expect(computeInteractive(50, residues)).toEqual(computeFamily(50, residues));
  });

  it('matches hard r=50 family 12515', () => {
    const residues: Point = [1, 24, 49];
    expect(computeInteractive(50, residues)).toEqual(computeFamily(50, residues));
  });

  it('preserves effective reduction before optimized computation', () => {
    const residues: Point = [2, 4, 6];
    expect(computeInteractive(10, residues)).toEqual(computeFamily(10, residues));
  });

  it('honors cancellation while building a cold modulus context', () => {
    expect(() => buildFastModulusContext(50, () => true)).toThrow(/cancel/i);
  });
});
