import type { EffectiveFamily, FamilyTransformCertificate, Point } from './asetsCore';

const PERMUTATIONS_3: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
}

function mod(value: number, modulus: number): number {
  const out = value % modulus;
  return out < 0 ? out + modulus : out;
}

function gcd(...values: number[]): number {
  let result = 0;
  for (const input of values) {
    assertSafeInteger(input, 'gcd input');
    let a = Math.abs(input);
    let b = result;
    while (a !== 0) {
      const next = b % a;
      b = a;
      a = next;
    }
    result = Math.abs(b);
  }
  return result;
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

function comparePoint(first: Point, second: Point): number {
  return first[0] - second[0] || first[1] - second[1] || first[2] - second[2];
}

/**
 * Browser runtime exactness guard.
 *
 * There is deliberately no product-level modulus cap. The current Number
 * backend runs any effective modulus for which the conservative exact integer
 * proof remains inside Number.MAX_SAFE_INTEGER. If a future group exceeds
 * this arithmetic backend, that is a backend-upgrade condition rather than a
 * normal support limit.
 */
export function assertExactRuntimeModulus(r: number): void {
  assertSafeInteger(r, 'r');
  if (r < 1) throw new Error('r must be positive');
  const bound = 27 * r ** 5;
  if (!Number.isSafeInteger(bound)) {
    throw new Error(`r=${r} exceeds the proven exact Number arithmetic envelope; a BigInt/WASM exact backend is required`);
  }
}

export function effectiveRuntimeFamily(r: number, residues: readonly number[]): EffectiveFamily {
  assertSafeInteger(r, 'r');
  if (r < 1) throw new Error('r must be positive');
  if (residues.length !== 3) throw new Error('expected positive modulus and three residues');
  const originalResidues: Point = residues.map((value) => {
    assertSafeInteger(value, 'residue');
    return mod(value, r);
  }) as unknown as Point;
  const originalModulus = r;
  const common = gcd(r, originalResidues[0], originalResidues[1], originalResidues[2]);
  const rEff = r / common;
  assertExactRuntimeModulus(rEff);
  const reducedResidues: Point = rEff === 1
    ? [0, 0, 0]
    : [
      mod(originalResidues[0] / common, rEff),
      mod(originalResidues[1] / common, rEff),
      mod(originalResidues[2] / common, rEff),
    ];

  if (rEff === 1) {
    return {
      r: 1,
      residues: [0, 0, 0],
      certificate: {
        originalModulus,
        originalResidues,
        effectiveCommonFactor: common,
        effectiveModulus: 1,
        reducedResidues,
        canonicalResidues: [0, 0, 0],
        axisPermutation: [0, 1, 2],
        inverseAxisPermutation: [0, 1, 2],
        unitMultiplier: 0,
        unitInverse: 0,
      },
    };
  }

  const units: number[] = [];
  for (let unit = 1; unit < rEff; unit += 1) if (gcd(unit, rEff) === 1) units.push(unit);
  let best: Point | null = null;
  let bestPermutation: readonly [number, number, number] = [0, 1, 2];
  let bestUnit = 1;
  for (const permutation of PERMUTATIONS_3) {
    for (const unit of units) {
      const candidate: Point = [
        mod(unit * reducedResidues[permutation[0]], rEff),
        mod(unit * reducedResidues[permutation[1]], rEff),
        mod(unit * reducedResidues[permutation[2]], rEff),
      ];
      if (best === null || comparePoint(candidate, best) < 0) {
        best = candidate;
        bestPermutation = permutation;
        bestUnit = unit;
      }
    }
  }
  if (best === null) throw new Error('no unit scaling available');
  const inversePermutation = [0, 0, 0] as [number, number, number];
  for (let canonicalAxis = 0; canonicalAxis < 3; canonicalAxis += 1) {
    inversePermutation[bestPermutation[canonicalAxis]] = canonicalAxis;
  }
  const certificate: FamilyTransformCertificate = {
    originalModulus,
    originalResidues,
    effectiveCommonFactor: common,
    effectiveModulus: rEff,
    reducedResidues,
    canonicalResidues: best,
    axisPermutation: bestPermutation,
    inverseAxisPermutation: inversePermutation,
    unitMultiplier: bestUnit,
    unitInverse: inverseMod(bestUnit, rEff),
  };
  return { r: rEff, residues: best, certificate };
}
