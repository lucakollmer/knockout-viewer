import { possibleModuli, solveLinearCongruence, type Group8 } from './groupMath';

export type DirectField = 'd' | 'r' | 'n' | 'm' | 'k' | 'a' | 'b' | 'c';
export type DirectValues = Record<DirectField, string>;

export type CandidateChoice = {
  field: DirectField;
  values: number[];
  reason: string;
};

export type DirectResolution = {
  group: Group8 | null;
  inferred: Partial<Record<DirectField, number>>;
  choice: CandidateChoice | null;
  error: string | null;
  hint: string | null;
};

const FIELD_ORDER: DirectField[] = ['d', 'n', 'm', 'k', 'r', 'a', 'b', 'c'];

function parseOptional(value: string, field: DirectField): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function missingKey<T extends string>(keys: readonly T[], values: Partial<Record<T, number>>): T | null {
  const missing = keys.filter((key) => values[key] === undefined);
  return missing.length === 1 ? missing[0] : null;
}

export function resolveDirectValues(values: DirectValues): DirectResolution {
  const parsed: Partial<Record<DirectField, number>> = {};
  try {
    for (const field of FIELD_ORDER) {
      const value = parseOptional(values[field], field);
      if (value !== undefined) parsed[field] = value;
    }
  } catch (error) {
    return { group: null, inferred: {}, choice: null, error: error instanceof Error ? error.message : String(error), hint: null };
  }

  const inferred: Partial<Record<DirectField, number>> = {};
  const effective = (): Partial<Record<DirectField, number>> => ({ ...parsed, ...inferred });

  const dimensionKeys = ['d', 'n', 'm', 'k'] as const;
  const missingDimension = missingKey(dimensionKeys, parsed);
  const dimensionCount = dimensionKeys.filter((key) => parsed[key] !== undefined).length;
  if (dimensionCount >= 3) {
    const v = effective();
    if (missingDimension === 'd') inferred.d = (v.n as number) + (v.m as number) + (v.k as number);
    if (missingDimension === 'n') inferred.n = (v.d as number) - (v.m as number) - (v.k as number);
    if (missingDimension === 'm') inferred.m = (v.d as number) - (v.n as number) - (v.k as number);
    if (missingDimension === 'k') inferred.k = (v.d as number) - (v.n as number) - (v.m as number);
  }

  let v = effective();
  if (dimensionCount === 4 && (v.n as number) + (v.m as number) + (v.k as number) !== v.d) {
    return { group: null, inferred, choice: null, error: 'd must equal n + m + k', hint: null };
  }
  if (v.d !== undefined && v.d < 3) return { group: null, inferred, choice: null, error: 'd must be at least 3', hint: null };
  for (const field of ['n', 'm', 'k'] as const) {
    if (v[field] !== undefined && (v[field] as number) < 1) {
      return { group: null, inferred, choice: null, error: `${field} must be positive`, hint: null };
    }
  }

  const dimensionsReady = dimensionKeys.every((key) => effective()[key] !== undefined);
  if (!dimensionsReady) {
    return {
      group: null,
      inferred,
      choice: null,
      error: null,
      hint: 'Enter any three of d, n, m, k; the fourth is inferred.',
    };
  }

  v = effective();
  const residueKeys = ['r', 'a', 'b', 'c'] as const;
  const residueCount = residueKeys.filter((key) => parsed[key] !== undefined).length;
  const missingResidue = missingKey(residueKeys, parsed);

  if (parsed.r !== undefined && parsed.r < 1) {
    return { group: null, inferred, choice: null, error: 'r must be positive', hint: null };
  }
  for (const field of ['a', 'b', 'c'] as const) {
    if (parsed[field] !== undefined && (parsed[field] as number) < 0) {
      return { group: null, inferred, choice: null, error: `${field} must be non-negative`, hint: null };
    }
  }

  if (residueCount >= 3 && missingResidue) {
    if (missingResidue === 'r') {
      const result = possibleModuli(
        v.n as number,
        v.m as number,
        v.k as number,
        v.a as number,
        v.b as number,
        v.c as number,
      );
      if (result.indeterminate) {
        return { group: null, inferred, choice: null, error: null, hint: 'The weighted residue sum is 0, so r is not determined; enter r.' };
      }
      if (result.tooLarge) {
        return { group: null, inferred, choice: null, error: null, hint: 'Enter r explicitly for this large weighted residue sum.' };
      }
      if (result.candidates.length === 0) {
        return { group: null, inferred, choice: null, error: 'No modulus r is compatible with these residues.', hint: null };
      }
      if (result.candidates.length === 1) inferred.r = result.candidates[0];
      else {
        return {
          group: null,
          inferred,
          choice: { field: 'r', values: result.candidates, reason: 'Several moduli divide the weighted residue sum.' },
          error: null,
          hint: null,
        };
      }
    } else {
      const r = v.r as number;
      const coefficients = { a: v.n as number, b: v.m as number, c: v.k as number };
      const knownSum =
        (missingResidue === 'a' ? 0 : (v.n as number) * (v.a as number)) +
        (missingResidue === 'b' ? 0 : (v.m as number) * (v.b as number)) +
        (missingResidue === 'c' ? 0 : (v.k as number) * (v.c as number));
      const candidates = solveLinearCongruence(coefficients[missingResidue], -knownSum, r);
      if (candidates.length === 0) {
        return { group: null, inferred, choice: null, error: `No value of ${missingResidue} satisfies the SL congruence.`, hint: null };
      }
      if (candidates.length === 1) inferred[missingResidue] = candidates[0];
      else {
        return {
          group: null,
          inferred,
          choice: {
            field: missingResidue,
            values: candidates,
            reason: `The coefficient of ${missingResidue} is not invertible modulo r, so there are several valid residues.`,
          },
          error: null,
          hint: null,
        };
      }
    }
  }

  v = effective();
  if (!residueKeys.every((key) => v[key] !== undefined)) {
    return {
      group: null,
      inferred,
      choice: null,
      error: null,
      hint: 'Enter any three of r, a, b, c; a missing residue is inferred when the congruence determines it.',
    };
  }

  const [r, a, b, c] = [v.r, v.a, v.b, v.c] as number[];
  if (r < 1) return { group: null, inferred, choice: null, error: 'r must be positive', hint: null };
  const weighted = (v.n as number) * a + (v.m as number) * b + (v.k as number) * c;
  if (((weighted % r) + r) % r !== 0) {
    return { group: null, inferred, choice: null, error: 'n·a + m·b + k·c must be divisible by r', hint: null };
  }

  return {
    group: [v.d as number, r, v.n as number, v.m as number, v.k as number, a, b, c],
    inferred,
    choice: null,
    error: null,
    hint: null,
  };
}

export function emptyDirectValues(): DirectValues {
  return { d: '', r: '', n: '', m: '', k: '', a: '', b: '', c: '' };
}
