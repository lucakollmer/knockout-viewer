import { describe, expect, it } from 'vitest';
import {
  canonicalizePresentation,
  enumerateCanonicalGroupsForModulus,
  possibleModuli,
  solveLinearCongruence,
} from '../src/groupMath';

describe('canonical group math', () => {
  it('uses the settled C-first display convention', () => {
    expect(canonicalizePresentation([4, 5, 2, 1, 1, 1, 2, 1])).toEqual([4, 5, 2, 1, 1, 1, 1, 2]);
  });

  it('reduces non-effective presentations before canonicalizing', () => {
    expect(canonicalizePresentation([3, 10, 1, 1, 1, 2, 4, 4])).toEqual(
      canonicalizePresentation([3, 5, 1, 1, 1, 1, 2, 2]),
    );
  });

  it('enumerates fixed (d,r) batches in canonical database order', () => {
    const rows = enumerateCanonicalGroupsForModulus(3, 5);
    const key = (row: (typeof rows)[number]) => [row[4], row[3], row[2], row[5], row[6], row[7]];
    const compare = (left: number[], right: number[]) => {
      for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return left[i] - right[i];
      }
      return 0;
    };
    expect(rows).toEqual([...rows].sort((left, right) => compare(key(left), key(right))));
  });

  it('solves non-invertible linear congruences without inventing uniqueness', () => {
    expect(solveLinearCongruence(2, 2, 6)).toEqual([1, 4]);
    expect(solveLinearCongruence(2, 1, 6)).toEqual([]);
  });

  it('derives finite modulus candidates from the weighted residue sum', () => {
    expect(possibleModuli(1, 1, 1, 1, 2, 3).candidates).toEqual([6]);
  });
});
