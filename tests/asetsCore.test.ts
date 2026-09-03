import { describe, expect, it } from 'vitest';
import {
  CancelledError,
  buildModulusContext,
  compareDownsets,
  computeFamily,
  effectiveFamily,
  effectiveFamilyKey,
  familyCacheKey,
  familyDigest,
  iterFamilyRecords,
  quotientLatticeScale,
  transportPointToPresentation,
} from '../src/asetsCore';

describe('portable-asets-reference-v1 TypeScript port', () => {
  it('normalizes effective residue orbits exactly', () => {
    expect(effectiveFamilyKey(5, [1, 2, 2])).toEqual([5, [1, 1, 3]]);
    expect(effectiveFamilyKey(10, [2, 4, 6])).toEqual([5, [1, 2, 3]]);
    expect(effectiveFamilyKey(200, [2, 4, 6])).toEqual([100, [1, 2, 3]]);
    expect(familyCacheKey(10, [2, 4, 6]).slice(1)).toEqual([5, 1, 2, 3]);
  });

  it('matches the frozen small-family digest', async () => {
    const result = computeFamily(4, [1, 2, 3]);
    expect(result.records).toHaveLength(7);
    expect(await familyDigest(result)).toBe('f3a127d19eb96c1e41151ca1674d1587a1bec6078a7cedc3310e98429788fa9b');
  });

  it('preserves zero/repeated-axis behavior', async () => {
    const zeroRepeated = computeFamily(2, [0, 1, 1]);
    expect(zeroRepeated.records).toHaveLength(2);
    expect(await familyDigest(zeroRepeated)).toBe('caeb178df38ef67abc63d35038d167fdf66a497ac7294befd73668dbf390c999');

    const allRepeated = computeFamily(2, [1, 1, 1]);
    expect(allRepeated.records).toHaveLength(3);
    expect(await familyDigest(allRepeated)).toBe('989e875e2a1974fc0ecd0167247dd4faa2b0113123ac2fb3248ff357b3b52926');
  });

  it('matches the frozen noncoherent sentinel', async () => {
    const result = computeFamily(14, [1, 9, 11]);
    expect(result.records).toHaveLength(35);
    expect(result.records.filter((record) => record.coherent)).toHaveLength(33);
    expect(await familyDigest(result)).toBe('219f70e239e54e83e45ebb129155a7f86ae3b148ad3c73ba3eb823c1a5a532ee');
  });

  it('matches the frozen hard r=50 sentinel', async () => {
    const result = computeFamily(50, [1, 24, 49]);
    expect(result.records).toHaveLength(386);
    expect(await familyDigest(result)).toBe('713db807af7888ffe80f13f408bfa3e55912e8a94770a1d6fa1abd2a210546d5');
  });

  it('streams the same records as collected computation', () => {
    const context = buildModulusContext(9);
    const streamed = [...iterFamilyRecords(9, [0, 1, 8], { modulusContext: context })]
      .sort((left, right) => compareDownsets(left.downset, right.downset));
    expect(streamed).toEqual(computeFamily(9, [0, 1, 8], { modulusContext: context }).records);
  });

  it('uses the exact quotient-lattice closed form', () => {
    const brute = (r: number, residues: readonly [number, number, number], ray: readonly [number, number, number]): number => {
      for (let scale = 1; scale <= r; scale += 1) {
        const target = ray.map((x) => ((scale * x) % r + r) % r);
        for (let h = 0; h < r; h += 1) {
          if (target.every((value, axis) => value === ((h * residues[axis]) % r + r) % r)) return scale;
        }
      }
      throw new Error('no quotient scale');
    };
    const cases = [
      [5, [1, 2, 3], [1, 0, 0]],
      [14, [1, 9, 11], [3, 2, 1]],
      [50, [1, 24, 49], [49, 26, 1]],
    ] as const;
    for (const [r, residues, ray] of cases) expect(quotientLatticeScale(r, residues, ray)).toBe(brute(r, residues, ray));
  });

  it('cancels through the search-node cancellation surface', () => {
    expect(() => computeFamily(50, [1, 24, 49], { cancelCheck: () => true })).toThrow(CancelledError);
  });

  it('retains a coordinate transport certificate', () => {
    const normalized = effectiveFamily(5, [2, 1, 2]);
    expect(normalized.residues).toEqual([1, 1, 3]);
    expect(normalized.certificate.axisPermutation).toEqual([0, 2, 1]);
    expect(normalized.certificate.unitMultiplier).toBe(3);
    expect(transportPointToPresentation([1, 2, 3], normalized.certificate)).toEqual([1, 3, 2]);
  });

  it('rejects moduli beyond the established Number safety envelope', () => {
    expect(() => computeFamily(101, [1, 2, 3])).toThrow(/r<=100/);
  });
});
