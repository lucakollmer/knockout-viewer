export type Group8 = readonly [
  d: number,
  r: number,
  n: number,
  m: number,
  k: number,
  a: number,
  b: number,
  c: number,
];

export type GroupRow = {
  id: string;
  d: number;
  r: number;
  n: number;
  m: number;
  k: number;
  a: number;
  b: number;
  c: number;
};

type RepPair = readonly [residue: number, multiplicity: number];
type Rep = readonly RepPair[];
type Display6 = readonly [n: number, m: number, k: number, a: number, b: number, c: number];

const unitsCache = new Map<number, readonly number[]>();
const solutionTableCache = new Map<string, readonly (readonly number[])[]>();

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
}

export function mod(value: number, modulus: number): number {
  const out = value % modulus;
  return out < 0 ? out + modulus : out;
}

export function gcd(...values: number[]): number {
  let g = 0;
  for (const input of values) {
    let a = Math.abs(input);
    let b = g;
    while (a !== 0) {
      const t = b % a;
      b = a;
      a = t;
    }
    g = Math.abs(b);
  }
  return g;
}

function extendedGcd(a: number, b: number): readonly [number, number, number] {
  let oldR = a;
  let r = b;
  let oldS = 1;
  let s = 0;
  let oldT = 0;
  let t = 1;
  while (r !== 0) {
    const q = Math.floor(oldR / r);
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
    [oldT, t] = [t, oldT - q * t];
  }
  return [oldR, oldS, oldT];
}

function inverseMod(a: number, modulus: number): number {
  if (modulus === 1) return 0;
  const [g, x] = extendedGcd(mod(a, modulus), modulus);
  if (g !== 1) throw new Error('inverse does not exist');
  return mod(x, modulus);
}

export function unitsMod(r: number): readonly number[] {
  const cached = unitsCache.get(r);
  if (cached) return cached;
  const units: number[] = [];
  for (let u = 1; u < r; u += 1) {
    if (gcd(u, r) === 1) units.push(u);
  }
  unitsCache.set(r, units);
  return units;
}

function solutionTable(r: number, coefficient: number): readonly (readonly number[])[] {
  const key = `${r}:${coefficient}`;
  const cached = solutionTableCache.get(key);
  if (cached) return cached;

  const g = gcd(coefficient, r);
  const kp = coefficient / g;
  const rp = r / g;
  const inverse = inverseMod(kp, rp);
  const out: number[][] = [];

  for (let rhs = 0; rhs < r; rhs += 1) {
    if (rhs % g !== 0) {
      out.push([]);
      continue;
    }
    const base = rp === 1 ? 0 : mod((rhs / g) * inverse, rp);
    const solutions: number[] = [];
    for (let t = 0; t < g; t += 1) {
      solutions.push(base + t * rp);
    }
    out.push(solutions);
  }

  solutionTableCache.set(key, out);
  return out;
}

function compareNumberTuples(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compareRep(a: Rep, b: Rep): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const pairComparison = compareNumberTuples(a[i], b[i]);
    if (pairComparison !== 0) return pairComparison;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compareRepPair(left: RepPair, right: RepPair): number {
  return left[0] - right[0] || left[1] - right[1];
}

function scaledRepPair(pair: RepPair, r: number, unit: number): RepPair {
  return [mod(unit * pair[0], r), pair[1]];
}

function scaleRep(rep: Rep, r: number, unit: number): Rep {
  if (rep.length === 1) return [scaledRepPair(rep[0], r, unit)];

  if (rep.length === 2) {
    const first = scaledRepPair(rep[0], r, unit);
    const second = scaledRepPair(rep[1], r, unit);
    return compareRepPair(first, second) <= 0 ? [first, second] : [second, first];
  }

  if (rep.length === 3) {
    let first = scaledRepPair(rep[0], r, unit);
    let second = scaledRepPair(rep[1], r, unit);
    let third = scaledRepPair(rep[2], r, unit);
    if (compareRepPair(first, second) > 0) [first, second] = [second, first];
    if (compareRepPair(second, third) > 0) [second, third] = [third, second];
    if (compareRepPair(first, second) > 0) [first, second] = [second, first];
    return [first, second, third];
  }

  return rep
    .map((pair) => scaledRepPair(pair, r, unit))
    .sort(compareRepPair);
}

function repKey(rep: Rep): string {
  return rep.map(([residue, multiplicity]) => `${residue}:${multiplicity}`).join('|');
}

function isCanonicalRepresentation(r: number, rep: Rep): boolean {
  for (const unit of unitsMod(r)) {
    if (compareRep(scaleRep(rep, r, unit), rep) < 0) return false;
  }
  return true;
}

function canonicalRepresentation(r: number, rep: Rep): Rep {
  let best = rep;
  for (const unit of unitsMod(r)) {
    const candidate = scaleRep(rep, r, unit);
    if (compareRep(candidate, best) < 0) best = candidate;
  }
  return best;
}

function displayKey(candidate: Display6): readonly number[] {
  const [n, m, k, a, b, c] = candidate;
  return [k, m, n, a, b, c];
}

const PERMUTATIONS_3: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function leastPermutation(base: readonly RepPair[]): Display6 {
  let best: Display6 | undefined;
  for (const [i, j, k] of PERMUTATIONS_3) {
    const candidate: Display6 = [
      base[i][1],
      base[j][1],
      base[k][1],
      base[i][0],
      base[j][0],
      base[k][0],
    ];
    if (!best || compareNumberTuples(displayKey(candidate), displayKey(best)) < 0) {
      best = candidate;
    }
  }
  if (!best) throw new Error('no display permutation');
  return best;
}

function displayFixedRepresentation(rep: Rep): Display6 {
  if (rep.length === 1) {
    const [w, s] = rep[0];
    if (s < 3) throw new Error('a three-positive-block display needs d>=3');
    return [s - 2, 1, 1, w, w, w];
  }

  let best: Display6 | undefined;
  if (rep.length === 2) {
    const [[w1, s1], [w2, s2]] = rep;
    for (let x = 1; x < s1; x += 1) {
      const candidate = leastPermutation([
        [w1, x],
        [w1, s1 - x],
        [w2, s2],
      ]);
      if (!best || compareNumberTuples(displayKey(candidate), displayKey(best)) < 0) best = candidate;
    }
    for (let x = 1; x < s2; x += 1) {
      const candidate = leastPermutation([
        [w1, s1],
        [w2, x],
        [w2, s2 - x],
      ]);
      if (!best || compareNumberTuples(displayKey(candidate), displayKey(best)) < 0) best = candidate;
    }
    if (!best) throw new Error('two-character representation cannot be displayed with three positive blocks');
    return best;
  }

  if (rep.length === 3) {
    return leastPermutation(rep);
  }

  throw new Error('Knockout three-block presentations have support size at most three');
}

function displayFromRepresentation(r: number, rep: Rep): Display6 {
  let best: Display6 | undefined;
  for (const unit of unitsMod(r)) {
    const candidate = displayFixedRepresentation(scaleRep(rep, r, unit));
    if (!best || compareNumberTuples(displayKey(candidate), displayKey(best)) < 0) best = candidate;
  }
  if (!best) throw new Error('no unit scaling available');
  return best;
}

function aggregateRepresentation(
  n: number,
  m: number,
  k: number,
  a: number,
  b: number,
  c: number,
): Rep {
  const counts = new Map<number, number>();
  for (const [multiplicity, residue] of [
    [n, a],
    [m, b],
    [k, c],
  ] as const) {
    counts.set(residue, (counts.get(residue) ?? 0) + multiplicity);
  }
  return [...counts.entries()]
    .map(([residue, multiplicity]) => [residue, multiplicity] as const)
    .sort((left, right) => left[0] - right[0]);
}

export function canonicalizePresentation(group: Group8): Group8 | null {
  let [d, r, n, m, k, a, b, c] = group;
  for (const [name, value] of Object.entries({ d, r, n, m, k, a, b, c })) {
    assertSafeInteger(value, name);
  }
  if (r < 1 || Math.min(n, m, k) < 1 || n + m + k !== d) {
    throw new Error('require r>=1, n,m,k>=1 and d=n+m+k');
  }

  a = mod(a, r);
  b = mod(b, r);
  c = mod(c, r);
  if (mod(n * a + m * b + k * c, r) !== 0) {
    throw new Error('presentation does not satisfy n·a + m·b + k·c ≡ 0 (mod r)');
  }

  const common = gcd(r, a, b, c);
  r /= common;
  a /= common;
  b /= common;
  c /= common;
  if (r === 1) return null;

  const representation = canonicalRepresentation(r, aggregateRepresentation(n, m, k, a, b, c));
  const [nn, mm, kk, aa, bb, cc] = displayFromRepresentation(r, representation);
  return [d, r, nn, mm, kk, aa, bb, cc];
}

export function groupRow(group: Group8): GroupRow {
  const [d, r, n, m, k, a, b, c] = group;
  return {
    id: `${d}:${r}:${n}:${m}:${k}:${a}:${b}:${c}`,
    d,
    r,
    n,
    m,
    k,
    a,
    b,
    c,
  };
}

export function groupTuple(row: GroupRow): Group8 {
  return [row.d, row.r, row.n, row.m, row.k, row.a, row.b, row.c];
}

export function compareGroups(left: Group8, right: Group8): number {
  const [ld, lr, ln, lm, lk, la, lb, lc] = left;
  const [rd, rr, rn, rm, rk, ra, rb, rc] = right;
  return compareNumberTuples(
    [ld, lr, lk, lm, ln, la, lb, lc],
    [rd, rr, rk, rm, rn, ra, rb, rc],
  );
}

/** Enumerate the exact canonical batch for one (d,r), in database order. */
export function enumerateCanonicalGroupsForModulus(d: number, r: number): Group8[] {
  assertSafeInteger(d, 'd');
  assertSafeInteger(r, 'r');
  if (d < 3) throw new Error('d must be at least 3');
  if (r < 2) throw new Error('r must be at least 2');

  const reps = new Map<string, Rep>();
  const addIfCanonical = (rep: Rep): void => {
    if (!isCanonicalRepresentation(r, rep)) return;
    reps.set(repKey(rep), rep);
  };

  if (d % r === 0) {
    const rep: Rep = [[1, d]];
    reps.set(repKey(rep), rep);
  }

  for (let s1 = 1; s1 < d; s1 += 1) {
    const s2 = d - s1;
    const table = solutionTable(r, s2);
    for (let x = 0; x < r; x += 1) {
      const rhs = mod(-s1 * x, r);
      const rxGcd = gcd(r, x);
      for (const y of table[rhs]) {
        if (x >= y || (rxGcd !== 1 && gcd(rxGcd, y) !== 1)) continue;
        addIfCanonical([
          [x, s1],
          [y, s2],
        ]);
      }
    }
  }

  for (let s1 = 1; s1 < d - 1; s1 += 1) {
    for (let s2 = 1; s2 < d - s1; s2 += 1) {
      const s3 = d - s1 - s2;
      const table = solutionTable(r, s3);
      for (let x = 0; x < r - 2; x += 1) {
        const sx = s1 * x;
        const rxGcd = gcd(r, x);
        for (let y = x + 1; y < r - 1; y += 1) {
          const rhs = mod(-sx - s2 * y, r);
          const rxyGcd = rxGcd === 1 ? 1 : gcd(rxGcd, y);
          for (const z of table[rhs]) {
            if (z <= y || (rxyGcd !== 1 && gcd(rxyGcd, z) !== 1)) continue;
            addIfCanonical([
              [x, s1],
              [y, s2],
              [z, s3],
            ]);
          }
        }
      }
    }
  }

  const rows: Group8[] = [];
  for (const rep of reps.values()) {
    const [n, m, k, a, b, c] = displayFromRepresentation(r, rep);
    rows.push([d, r, n, m, k, a, b, c]);
  }
  rows.sort(compareGroups);
  return rows;
}

export function solveLinearCongruence(coefficient: number, rhs: number, r: number): number[] {
  for (const [name, value] of Object.entries({ coefficient, rhs, r })) assertSafeInteger(value, name);
  if (r < 1) throw new Error('r must be positive');
  const g = gcd(coefficient, r);
  const target = mod(rhs, r);
  if (target % g !== 0) return [];
  const reducedR = r / g;
  const base = reducedR === 1
    ? 0
    : mod((target / g) * inverseMod(coefficient / g, reducedR), reducedR);
  const solutions: number[] = [];
  for (let t = 0; t < g; t += 1) solutions.push(base + t * reducedR);
  return solutions.sort((a, b) => a - b);
}

export function possibleModuli(
  n: number,
  m: number,
  k: number,
  a: number,
  b: number,
  c: number,
  divisorScanLimit = 100_000_000,
): { candidates: number[]; indeterminate: boolean; tooLarge: boolean } {
  const total = n * a + m * b + k * c;
  if (!Number.isSafeInteger(total)) return { candidates: [], indeterminate: false, tooLarge: true };
  const minimum = Math.max(2, a + 1, b + 1, c + 1);
  if (total === 0) return { candidates: [], indeterminate: true, tooLarge: false };
  const absolute = Math.abs(total);
  if (absolute > divisorScanLimit) return { candidates: [], indeterminate: false, tooLarge: true };

  const divisors = new Set<number>();
  for (let q = 1; q * q <= absolute; q += 1) {
    if (absolute % q !== 0) continue;
    const other = absolute / q;
    if (q >= minimum) divisors.add(q);
    if (other >= minimum) divisors.add(other);
  }
  return { candidates: [...divisors].sort((x, y) => x - y), indeterminate: false, tooLarge: false };
}

export function formatGroup(row: Pick<GroupRow, 'r' | 'n' | 'm' | 'k' | 'a' | 'b' | 'c'>): string {
  return `1/${row.r}(${row.a}^${row.n}, ${row.b}^${row.m}, ${row.c}^${row.k})`;
}
