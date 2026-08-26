import { describe, expect, it } from 'vitest';
import { emptyDirectValues, resolveDirectValues } from '../src/directInput';

function values(patch: Partial<ReturnType<typeof emptyDirectValues>>) {
  return { ...emptyDirectValues(), ...patch };
}

describe('direct selection inference', () => {
  it('infers d from n,m,k', () => {
    const result = resolveDirectValues(values({ n: '2', m: '1', k: '1' }));
    expect(result.inferred.d).toBe(4);
  });

  it('infers a missing multiplicity', () => {
    const result = resolveDirectValues(values({ d: '8', m: '2', k: '1' }));
    expect(result.inferred.n).toBe(5);
  });

  it('infers a uniquely determined residue', () => {
    const result = resolveDirectValues(values({ d: '3', n: '1', m: '1', k: '1', r: '5', a: '1', b: '1' }));
    expect(result.inferred.c).toBe(3);
    expect(result.group).toEqual([3, 5, 1, 1, 1, 1, 1, 3]);
  });

  it('offers choices when a residue is not unique', () => {
    const result = resolveDirectValues(values({ d: '4', n: '2', m: '1', k: '1', r: '6', b: '1', c: '3' }));
    expect(result.choice?.field).toBe('a');
    expect(result.choice?.values.length).toBeGreaterThan(1);
  });

  it('infers r when there is exactly one admissible divisor', () => {
    const result = resolveDirectValues(values({ d: '3', n: '1', m: '1', k: '1', a: '1', b: '2', c: '3' }));
    expect(result.inferred.r).toBe(6);
  });

  it('rejects negative direct residues instead of making modulus inference ambiguous', () => {
    const result = resolveDirectValues(values({ d: '3', n: '1', m: '1', k: '1', r: '5', a: '-1', b: '1', c: '0' }));
    expect(result.error).toMatch(/non-negative/);
  });

  it('rejects inconsistent dimensions early', () => {
    const result = resolveDirectValues(values({ d: '7', n: '2', m: '2', k: '2' }));
    expect(result.error).toMatch(/n \+ m \+ k/);
  });
});
