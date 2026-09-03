export type Point = readonly [number, number, number];
export type CancelCheck = () => boolean;

export const ASETS_ENGINE_VERSION = 'portable-asets-reference-v1-ts1';
export const ASETS_SCHEMA_VERSION = 1;
export const MAX_EXACT_MODULUS = 100;

export class CancelledError extends Error {
  constructor(message = 'Asets family computation cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export type BoxSpec = {
  point: Point;
  points: readonly Point[];
};

export type ModulusContext = {
  r: number;
  boxes: readonly BoxSpec[];
  units: readonly number[];
};

export type Candidate = {
  point: Point;
  assignments: readonly (readonly [number, Point])[];
};

export type SearchMetrics = {
  nodes: number;
  compatibilityChecks: number;
  singletonPropagations: number;
  branches: number;
  candidateCount: number;
};

export type DownsetRecord = {
  downset: readonly Point[];
  transitionRows: readonly Point[];
  coherent: boolean;
  witness: Point | null;
  activeAxes: readonly number[];
  inactiveAxes: readonly number[];
  shape: 'noncoherent' | 'triangle' | 'quadrilateral' | 'polygon';
  lowRays: readonly Point[];
};

export type FamilyResult = {
  r: number;
  residues: Point;
  records: readonly DownsetRecord[];
};

export type FamilyTransformCertificate = {
  originalModulus: number;
  originalResidues: Point;
  effectiveCommonFactor: number;
  effectiveModulus: number;
  reducedResidues: Point;
  canonicalResidues: Point;
  /** canonical axis -> presentation axis */
  axisPermutation: readonly [number, number, number];
  /** presentation axis -> canonical axis */
  inverseAxisPermutation: readonly [number, number, number];
  unitMultiplier: number;
  unitInverse: number;
};

export type EffectiveFamily = {
  r: number;
  residues: Point;
  certificate: FamilyTransformCertificate;
};

const PERMUTATIONS_3: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

export function createSearchMetrics(): SearchMetrics {
  return { nodes: 0, compatibilityChecks: 0, singletonPropagations: 0, branches: 0, candidateCount: 0 };
}

function maybeCancel(cancelCheck?: CancelCheck): void {
  if (cancelCheck?.()) throw new CancelledError();
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
}

function assertPointSafe(point: Point, name: string): void {
  assertSafeInteger(point[0], `${name}[0]`);
  assertSafeInteger(point[1], `${name}[1]`);
  assertSafeInteger(point[2], `${name}[2]`);
}

export function assertSupportedModulus(r: number): void {
  assertSafeInteger(r, 'r');
  if (r < 1) throw new Error('r must be positive');
  if (r > MAX_EXACT_MODULUS) {
    throw new Error(`r=${r} exceeds the exact TypeScript engine limit r<=${MAX_EXACT_MODULUS}`);
  }
  // With transition-row coordinates bounded by r and at most 3r rows,
  // a conservative coherence dot-product bound is 27*r^5.
  const bound = 27 * r ** 5;
  if (!Number.isSafeInteger(bound)) throw new Error(`r=${r} exceeds the proven Number integer-safety bound`);
}

export function mod(value: number, modulus: number): number {
  const out = value % modulus;
  return out < 0 ? out + modulus : out;
}

export function gcd(...values: number[]): number {
  let g = 0;
  for (const input of values) {
    assertSafeInteger(input, 'gcd input');
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

function comparePoint(a: Point, b: Point): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function comparePointByDegree(a: Point, b: Point): number {
  const sa = a[0] + a[1] + a[2];
  const sb = b[0] + b[1] + b[2];
  return sa - sb || comparePoint(a, b);
}

export function compareDownsets(a: readonly Point[], b: readonly Point[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const cmp = comparePoint(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}

function pointKey(point: Point): string {
  return `${point[0]},${point[1]},${point[2]}`;
}

function downsetKey(downset: readonly Point[]): string {
  return downset.map(pointKey).join(';');
}

function asPoint(values: readonly number[]): Point {
  const point: Point = [values[0], values[1], values[2]];
  assertPointSafe(point, 'point');
  return point;
}

function unitsFor(r: number): number[] {
  const units: number[] = [];
  for (let u = 1; u < r; u += 1) if (gcd(u, r) === 1) units.push(u);
  return units;
}

export function effectiveFamily(r: number, residues: readonly number[]): EffectiveFamily {
  assertSafeInteger(r, 'r');
  if (r < 1) throw new Error('r must be positive');
  if (residues.length !== 3) throw new Error('expected positive modulus and three residues');
  const originalResidues = asPoint(residues.map((x) => {
    assertSafeInteger(x, 'residue');
    return mod(x, r);
  }));
  const originalModulus = r;
  const common = gcd(r, originalResidues[0], originalResidues[1], originalResidues[2]);
  const rEff = r / common;
  const reducedResidues: Point = rEff === 1
    ? [0, 0, 0]
    : [
      mod(originalResidues[0] / common, rEff),
      mod(originalResidues[1] / common, rEff),
      mod(originalResidues[2] / common, rEff),
    ];
  if (rEff > MAX_EXACT_MODULUS) assertSupportedModulus(rEff);

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

  const units = unitsFor(rEff);
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

export function effectiveFamilyKey(r: number, residues: readonly number[]): readonly [number, Point] {
  const normalized = effectiveFamily(r, residues);
  return [normalized.r, normalized.residues];
}

export function familyCacheKey(r: number, residues: readonly number[]): readonly [string, number, number, number, number] {
  const normalized = effectiveFamily(r, residues);
  return [ASETS_ENGINE_VERSION, normalized.r, ...normalized.residues];
}

export function buildModulusContext(r: number, cancelCheck?: CancelCheck): ModulusContext {
  assertSupportedModulus(r);
  const boxes: BoxSpec[] = [];
  let tick = 0;
  for (let x = 0; x < r; x += 1) {
    for (let y = 0; y < r; y += 1) {
      const xy = (x + 1) * (y + 1);
      if (xy > r) break;
      const maxZ = Math.floor(r / xy) - 1;
      for (let z = 0; z <= maxZ; z += 1) {
        const point: Point = [x, y, z];
        const points: Point[] = [];
        for (let i = 0; i <= x; i += 1) {
          for (let j = 0; j <= y; j += 1) {
            for (let k = 0; k <= z; k += 1) points.push([i, j, k]);
          }
        }
        boxes.push({ point, points });
        tick += 1;
        if ((tick & 127) === 0) maybeCancel(cancelCheck);
      }
    }
  }
  return { r, boxes, units: unitsFor(r) };
}

export function character(point: Point, residues: Point, r: number): number {
  const value = point[0] * residues[0] + point[1] * residues[1] + point[2] * residues[2];
  assertSafeInteger(value, 'character dot product');
  return mod(value, r);
}

function familyCandidates(context: ModulusContext, residues: Point, cancelCheck?: CancelCheck): readonly (readonly Candidate[])[] {
  const { r } = context;
  const buckets: Candidate[][] = Array.from({ length: r }, () => []);
  for (let index = 0; index < context.boxes.length; index += 1) {
    const spec = context.boxes[index];
    const seen: (Point | undefined)[] = new Array(r);
    const assignments: (readonly [number, Point])[] = [];
    let valid = true;
    for (const point of spec.points) {
      const chi = character(point, residues, r);
      if (seen[chi] !== undefined) {
        valid = false;
        break;
      }
      seen[chi] = point;
      assignments.push([chi, point]);
    }
    if (valid) buckets[character(spec.point, residues, r)].push({ point: spec.point, assignments });
    if ((index & 127) === 0) maybeCancel(cancelCheck);
  }
  for (const bucket of buckets) bucket.sort((a, b) => comparePointByDegree(a.point, b.point));
  return buckets;
}

export function* iterDownsets(
  rInput: number,
  residuesInput: readonly number[],
  options: {
    modulusContext?: ModulusContext;
    cancelCheck?: CancelCheck;
    metrics?: SearchMetrics;
  } = {},
): Generator<readonly Point[]> {
  assertSupportedModulus(rInput);
  if (residuesInput.length !== 3) throw new Error('expected three residues');
  const r = rInput;
  const residues: Point = [mod(residuesInput[0], r), mod(residuesInput[1], r), mod(residuesInput[2], r)];
  const context = options.modulusContext ?? buildModulusContext(r, options.cancelCheck);
  if (context.r !== r) throw new Error('modulus context does not match r');
  const candidates = familyCandidates(context, residues, options.cancelCheck);
  if (options.metrics) options.metrics.candidateCount = candidates.reduce((sum, bucket) => sum + bucket.length, 0);

  const assigned: (Point | null)[] = Array.from({ length: r }, () => null);
  assigned[0] = [0, 0, 0];
  let assignedCount = 1;

  const compatible = (candidate: Candidate): boolean => {
    if (options.metrics) options.metrics.compatibilityChecks += 1;
    for (const [chi, point] of candidate.assignments) {
      const current = assigned[chi];
      if (current !== null && comparePoint(current, point) !== 0) return false;
    }
    return true;
  };

  const apply = (candidate: Candidate): number[] => {
    const added: number[] = [];
    for (const [chi, point] of candidate.assignments) {
      if (assigned[chi] === null) {
        assigned[chi] = point;
        added.push(chi);
      }
    }
    assignedCount += added.length;
    return added;
  };

  const undo = (added: readonly number[]): void => {
    for (const chi of added) assigned[chi] = null;
    assignedCount -= added.length;
  };

  const emit = (): readonly Point[] => (
    assigned.filter((point): point is Point => point !== null).slice().sort(comparePointByDegree)
  );

  function* search(): Generator<readonly Point[]> {
    if (options.metrics) options.metrics.nodes += 1;
    maybeCancel(options.cancelCheck);
    const propagated: number[][] = [];
    try {
      while (true) {
        if (assignedCount === r) {
          yield emit();
          return;
        }
        let bestCharacter: number | null = null;
        let bestDomain: Candidate[] | null = null;
        for (let chi = 1; chi < r; chi += 1) {
          if (assigned[chi] !== null) continue;
          const domain = candidates[chi].filter(compatible);
          if (domain.length === 0) return;
          if (
            bestDomain === null
            || domain.length < bestDomain.length
            || (domain.length === bestDomain.length && chi < (bestCharacter ?? Number.POSITIVE_INFINITY))
          ) {
            bestCharacter = chi;
            bestDomain = domain;
          }
          if (domain.length === 1) break;
        }
        if (bestDomain === null) throw new Error('internal CSP domain failure');
        if (bestDomain.length === 1) {
          const added = apply(bestDomain[0]);
          propagated.push(added);
          if (options.metrics) options.metrics.singletonPropagations += 1;
          continue;
        }
        if (options.metrics) options.metrics.branches += 1;
        for (const candidate of bestDomain) {
          const added = apply(candidate);
          try {
            yield* search();
          } finally {
            undo(added);
          }
        }
        return;
      }
    } finally {
      for (let i = propagated.length - 1; i >= 0; i -= 1) undo(propagated[i]);
    }
  }

  yield* search();
}

export function enumerateDownsets(
  r: number,
  residues: readonly number[],
  options: { modulusContext?: ModulusContext; cancelCheck?: CancelCheck; metrics?: SearchMetrics } = {},
): readonly (readonly Point[])[] {
  const result = [...iterDownsets(r, residues, options)].sort(compareDownsets);
  const keys = new Set(result.map(downsetKey));
  if (keys.size !== result.length) throw new Error('deterministic CSP emitted duplicate downsets');
  return result;
}

export function transitionRows(downset: readonly Point[], residues: Point, r: number): readonly Point[] {
  const beta: (Point | null)[] = Array.from({ length: r }, () => null);
  for (const point of downset) {
    const chi = character(point, residues, r);
    if (beta[chi] !== null) throw new Error('downset character map is not injective');
    beta[chi] = point;
  }
  if (beta.some((point) => point === null)) throw new Error('downset character map is not surjective');
  const rows = new Map<string, Point>();
  for (let chi = 0; chi < r; chi += 1) {
    const source = beta[chi] as Point;
    for (let axis = 0; axis < 3; axis += 1) {
      const lifted: [number, number, number] = [source[0], source[1], source[2]];
      lifted[axis] += 1;
      const target = beta[(chi + residues[axis]) % r] as Point;
      const row: Point = [lifted[0] - target[0], lifted[1] - target[1], lifted[2] - target[2]];
      assertPointSafe(row, 'transition row');
      if (row[0] !== 0 || row[1] !== 0 || row[2] !== 0) rows.set(pointKey(row), row);
    }
  }
  return [...rows.values()].sort(comparePoint);
}

function dot(a: Point, b: Point): number {
  const value = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  assertSafeInteger(value, 'dot product');
  return value;
}

function cross(a: Point, b: Point): Point {
  const result: Point = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  assertPointSafe(result, 'cross product');
  return result;
}

function primitive(vector: Point): Point {
  const common = gcd(Math.abs(vector[0]), Math.abs(vector[1]), Math.abs(vector[2]));
  if (common === 0) return vector;
  return [vector[0] / common, vector[1] / common, vector[2] / common];
}

function canonicalUnorientedLine(vector: Point): Point {
  const normalized = primitive(vector);
  for (const value of normalized) {
    if (value !== 0) return value < 0 ? [-normalized[0], -normalized[1], -normalized[2]] : normalized;
  }
  return normalized;
}

export function supportingNormals(rows: readonly Point[]): readonly Point[] {
  const lines = new Map<string, Point>();
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const normal = cross(rows[i], rows[j]);
      if (normal[0] !== 0 || normal[1] !== 0 || normal[2] !== 0) {
        const line = canonicalUnorientedLine(normal);
        lines.set(pointKey(line), line);
      }
    }
  }
  const normals = new Map<string, Point>();
  for (const normal of lines.values()) {
    let nonnegative = true;
    let nonpositive = true;
    for (const row of rows) {
      const value = dot(normal, row);
      if (value < 0) nonnegative = false;
      if (value > 0) nonpositive = false;
      if (!nonnegative && !nonpositive) break;
    }
    if (nonnegative) normals.set(pointKey(normal), normal);
    else if (nonpositive) {
      const reversed: Point = [-normal[0], -normal[1], -normal[2]];
      normals.set(pointKey(reversed), reversed);
    }
  }
  return [...normals.values()].sort(comparePoint);
}

export function coherence(rows: readonly Point[]): readonly [boolean, Point | null, readonly Point[]] {
  const normals = supportingNormals(rows);
  if (normals.length === 0) return [false, null, normals];
  const witness: Point = [
    normals.reduce((sum, normal) => sum + normal[0], 0),
    normals.reduce((sum, normal) => sum + normal[1], 0),
    normals.reduce((sum, normal) => sum + normal[2], 0),
  ];
  assertPointSafe(witness, 'coherence witness');
  if (!rows.every((row) => dot(row, witness) > 0)) return [false, null, normals];
  return [true, witness, normals];
}

export function quotientLatticeScale(r: number, residues: Point, ray: Point): number {
  const minors: Point = [
    residues[0] * ray[1] - residues[1] * ray[0],
    residues[0] * ray[2] - residues[2] * ray[0],
    residues[1] * ray[2] - residues[2] * ray[1],
  ];
  assertPointSafe(minors, 'quotient-lattice minors');
  const common = gcd(r, Math.abs(minors[0]), Math.abs(minors[1]), Math.abs(minors[2]));
  return r / common;
}

export function geometryRecord(downset: readonly Point[], residues: Point, r: number): DownsetRecord {
  const rows = transitionRows(downset, residues, r);
  const [coherent, witness, normals] = coherence(rows);
  const active = [0, 1, 2].filter((axis) => downset.some((point) => point[axis] !== 0));
  const inactive = [0, 1, 2].filter((axis) => !active.includes(axis));
  const low = new Map<string, Point>();
  if (coherent) {
    const inactiveBasis = new Set(inactive.map((axis) => pointKey([
      axis === 0 ? 1 : 0,
      axis === 1 ? 1 : 0,
      axis === 2 ? 1 : 0,
    ])));
    for (const ray of normals) {
      if (inactiveBasis.has(pointKey(ray))) continue;
      const scale = quotientLatticeScale(r, residues, ray);
      const scaled: Point = [scale * ray[0], scale * ray[1], scale * ray[2]];
      assertPointSafe(scaled, 'low ray');
      low.set(pointKey(scaled), scaled);
    }
  }
  const lowRays = [...low.values()].sort(comparePoint);
  const vertexCount = lowRays.length + inactive.length;
  const shape: DownsetRecord['shape'] = !coherent
    ? 'noncoherent'
    : vertexCount === 3
      ? 'triangle'
      : vertexCount === 4
        ? 'quadrilateral'
        : 'polygon';
  return {
    downset,
    transitionRows: rows,
    coherent,
    witness,
    activeAxes: active,
    inactiveAxes: inactive,
    shape,
    lowRays,
  };
}

export function* iterFamilyRecords(
  rInput: number,
  residuesInput: readonly number[],
  options: { modulusContext?: ModulusContext; cancelCheck?: CancelCheck; metrics?: SearchMetrics } = {},
): Generator<DownsetRecord> {
  const normalized = effectiveFamily(rInput, residuesInput);
  let context = options.modulusContext;
  if (context && context.r !== normalized.r) throw new Error('modulus context does not match effective modulus');
  context ??= buildModulusContext(normalized.r, options.cancelCheck);
  for (const downset of iterDownsets(normalized.r, normalized.residues, {
    modulusContext: context,
    cancelCheck: options.cancelCheck,
    metrics: options.metrics,
  })) {
    yield geometryRecord(downset, normalized.residues, normalized.r);
  }
}

export function computeFamily(
  rInput: number,
  residuesInput: readonly number[],
  options: { modulusContext?: ModulusContext; cancelCheck?: CancelCheck; metrics?: SearchMetrics } = {},
): FamilyResult {
  const normalized = effectiveFamily(rInput, residuesInput);
  let context = options.modulusContext;
  if (context && context.r !== normalized.r) throw new Error('modulus context does not match effective modulus');
  context ??= buildModulusContext(normalized.r, options.cancelCheck);
  const downsets = enumerateDownsets(normalized.r, normalized.residues, {
    modulusContext: context,
    cancelCheck: options.cancelCheck,
    metrics: options.metrics,
  });
  const records = downsets.map((downset) => geometryRecord(downset, normalized.residues, normalized.r));
  return { r: normalized.r, residues: normalized.residues, records };
}

export function familyPayload(result: FamilyResult): Record<string, unknown> {
  return {
    r: result.r,
    residues: [...result.residues],
    records: result.records.map((record) => ({
      downset: record.downset.map((point) => [...point]),
      transition_rows: record.transitionRows.map((row) => [...row]),
      coherent: record.coherent,
      witness: record.witness === null ? null : [...record.witness],
      active_axes: [...record.activeAxes],
      inactive_axes: [...record.inactiveAxes],
      shape: record.shape,
      low_rays: record.lowRays.map((ray) => [...ray]),
    })),
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function familyPayloadJson(result: FamilyResult): string {
  return stableStringify(familyPayload(result));
}

export async function familyDigest(result: FamilyResult): Promise<string> {
  const data = new TextEncoder().encode(familyPayloadJson(result));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function transportPointToPresentation(point: Point, certificate: FamilyTransformCertificate): Point {
  const out: [number, number, number] = [0, 0, 0];
  for (let canonicalAxis = 0; canonicalAxis < 3; canonicalAxis += 1) {
    out[certificate.axisPermutation[canonicalAxis]] = point[canonicalAxis];
  }
  return out;
}

export function transportRecordToPresentation(record: DownsetRecord, certificate: FamilyTransformCertificate): DownsetRecord {
  const mapPoint = (point: Point): Point => transportPointToPresentation(point, certificate);
  const activeAxes = record.activeAxes.map((axis) => certificate.axisPermutation[axis]).sort((a, b) => a - b);
  const inactiveAxes = record.inactiveAxes.map((axis) => certificate.axisPermutation[axis]).sort((a, b) => a - b);
  return {
    downset: record.downset.map(mapPoint).sort(comparePointByDegree),
    transitionRows: record.transitionRows.map(mapPoint).sort(comparePoint),
    coherent: record.coherent,
    witness: record.witness === null ? null : mapPoint(record.witness),
    activeAxes,
    inactiveAxes,
    shape: record.shape,
    lowRays: record.lowRays.map(mapPoint).sort(comparePoint),
  };
}
