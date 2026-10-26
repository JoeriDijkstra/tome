// Character state + compiled packs → a lazily evaluated view. Nothing here is ever stored.
// See docs/SPEC.md → Owned entities, Grants, Modifiers, Character model.
import type { CEntity, CModifier, Compiled, PathSeg } from './compile';
import { type Ast, type EvalCtx, evaluate, FormulaError, MAX_STEPS, truthy, withVars } from './formula';
import { clone } from './json';
import type * as S from './schema';

export type State = Record<string, unknown>;

export interface OwnedEntity {
  entity: CEntity;
  owner: unknown;
}
export interface ActiveFeature {
  id: string;
  name: string;
  summary: string | null;
  description: string | null;
  source: string;
  resource: string | null;
  actions: string[];
}
export interface ResourceState {
  id: string;
  label: string;
  max: number | null;
  current: number | null;
  temp: number | null;
  reset: string[];
}
export interface Contribution {
  source: string;
  op: CModifier['op'];
  type: string | null;
  value: number | null;
  applied: boolean;
}
export interface Breakdown {
  base: unknown;
  value: unknown;
  contributions: Contribution[];
}

export interface View {
  compiled: Compiled;
  /** stored state with defaults filled in (what effects write to) */
  state: State;
  /** evaluate a formula against this character */
  eval(src: S.FormulaSrc, vars?: Record<string, unknown>): unknown;
  /** render a text field (`"Level {@level}"`) */
  text(src: string, vars?: Record<string, unknown>): string;
  ctx(vars?: Record<string, unknown>): EvalCtx;
  root(name: string): unknown;
  owned(): OwnedEntity[];
  features(): ActiveFeature[];
  resources(): ResourceState[];
  /** where a modified value comes from, e.g. `ac` or `skills.stealth` */
  explain(path: string): Breakdown | undefined;
  violations(): { id: string; message: string }[];
  warnings: Set<string>;
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------- reconcile ----------

function defaultFor(def: S.FieldDef): unknown {
  if (def.default !== undefined) return clone(def.default);
  switch (def.type) {
    case 'number': return 0;
    case 'string': case 'text': return '';
    case 'boolean': return false;
    case 'list': return [];
    case 'map': return {};
    case 'object': return reconcileObject({}, def.fields ?? [], () => {});
    default: return null;
  }
}

function typeOk(v: unknown, type: S.FieldDef['type']): boolean {
  if (v === null) return true;
  switch (type) {
    case 'number': return typeof v === 'number';
    case 'string': case 'text': case 'select': case 'ref': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'list': return Array.isArray(v);
    case 'map': case 'object': return isPlain(v);
    default: return true;
  }
}

function reconcileValue(v: unknown, def: S.FieldDef, warn: (m: string) => void, path: string): unknown {
  if (v === undefined) return defaultFor(def);
  if (!typeOk(v, def.type)) { warn(`${path} has the wrong type; keeping the stored value`); return v; }
  if (def.type === 'object' && isPlain(v)) return reconcileObject(v, def.fields ?? [], warn, path);
  if (def.of === 'object' && def.fields) {
    if (def.type === 'list' && Array.isArray(v)) return v.map((row, i) => (isPlain(row) ? reconcileObject(row, def.fields!, warn, `${path}[${i}]`) : row));
    if (def.type === 'map' && isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, row]) => [k, isPlain(row) ? reconcileObject(row, def.fields!, warn, `${path}.${k}`) : row]));
  }
  return v;
}

function reconcileObject(v: Record<string, unknown>, defs: S.FieldDef[], warn: (m: string) => void, path = ''): Record<string, unknown> {
  // unknown keys are kept, missing keys get defaults
  const out: Record<string, unknown> = { ...v };
  for (const def of defs) out[def.key] = reconcileValue(v[def.key], def, warn, path ? `${path}.${def.key}` : def.key);
  return out;
}

/** Fill defaults for missing fields; keep unknown keys and wrongly typed values (with a warning). */
export function reconcile(compiled: Compiled, stored: State, warn: (m: string) => void = () => {}): State {
  const out = reconcileObject(stored, compiled.fields, warn);
  if (stored.res === undefined) out.res = {};
  else if (!isPlain(stored.res)) warn('res has the wrong type; keeping the stored value');
  return out;
}

// ---------- view ----------

export function createView(compiled: Compiled, stored: State, name = ''): View {
  const warnings = new Set<string>();
  // warnings name the formula being evaluated (file#pointer from compile)
  const location: string[] = [];
  const warn = (m: string) => { warnings.add(location.length ? `${location[location.length - 1]}: ${m}` : m); };
  const state = reconcile(compiled, stored, warn);
  const memo = new Map<string, unknown>();
  const inProgress = new Set<string>();
  const breakdowns = new Map<string, Breakdown>();
  let ownedCache: OwnedEntity[] | undefined;
  let ownedEnvelopes: Record<string, unknown>[] | undefined;
  let resCache: Record<string, ResourceState> | undefined;
  let ownedBusy = false;

  const envelope = (id: string) => compiled.entities.get(id)?.envelope;
  const baseCtx: EvalCtx = {
    budget: { steps: MAX_STEPS, nest: 0 },
    root: (n) => root(n),
    vars: {},
    table: (id) => compiled.tables.get(id),
    entity: (id) => envelope(id) ?? null,
    entities: (type) => (compiled.byType.get(type) ?? []).map((e) => e.envelope),
    warn,
  };
  const ctx = (vars?: Record<string, unknown>) => (vars ? withVars(baseCtx, vars) : baseCtx);
  /** Evaluate a formula. The outermost call gets a fresh step budget and turns formula errors into null + a warning. */
  function run(ast: Ast, vars?: Record<string, unknown>): unknown {
    const top = location.length === 0;
    location.push(compiled.locate(ast) ?? location[location.length - 1] ?? 'formula');
    if (top) baseCtx.budget.steps = MAX_STEPS;
    try {
      return evaluate(ast, ctx(vars));
    } catch (e) {
      if (!top || !(e instanceof FormulaError)) throw e;
      warn(e.message);
      return null;
    } finally {
      location.pop();
    }
  }
  const entityVars = (o: OwnedEntity) => ({ self: o.entity.envelope, owner: o.owner });

  function root(name: string): unknown {
    if (name === 'name') return docName;
    if (name === 'base') return state;
    if (name === 'res') return resObject();
    if (name === 'features') return features();
    if (name === 'owned') return (ownedEnvelopes ??= owned().map((o) => ({ ...o.entity.envelope, owner: o.owner })));
    if (memo.has(name)) return memo.get(name);
    if (inProgress.has(name)) throw new FormulaError(`@${name} depends on itself`);
    inProgress.add(name);
    try {
      let value: unknown = null;
      const d = compiled.derived.get(name);
      if (d) value = computeDerived(d.formula, d.each, d.eachType);
      else if (compiled.fieldByKey.has(name)) value = state[name];
      value = applyModifiers(name, value);
      memo.set(name, value);
      return value;
    } finally {
      inProgress.delete(name);
    }
  }
  const docName = name;

  function computeDerived(formula: Ast, each?: string, eachType?: string): unknown {
    if (each) {
      const src = root(each);
      if (Array.isArray(src)) return src.map((v, k) => run(formula, { v, k }));
      if (isPlain(src)) return Object.fromEntries(Object.entries(src).map(([k, v]) => [k, run(formula, { v, k })]));
      return null;
    }
    if (eachType) return Object.fromEntries((compiled.byType.get(eachType) ?? []).map((e) => [e.id, run(formula, { v: e.envelope, k: e.id })]));
    return run(formula);
  }

  // ----- ownership -----
  function owned(): OwnedEntity[] {
    if (ownedCache) return ownedCache;
    if (ownedBusy) throw new FormulaError('ownership depends on itself');
    ownedBusy = true;
    try {
      ownedCache = collectOwned();
      return ownedCache;
    } finally {
      ownedBusy = false;
    }
  }

  function collectOwned(): OwnedEntity[] {
    const found = new Map<string, OwnedEntity>();
    const add = (id: unknown, owner: unknown) => {
      // ponytail: an entity counts once (first owner wins); per-instance stacking if a system needs it
      if (typeof id !== 'string' || found.has(id)) return;
      const entity = compiled.entities.get(id);
      if (entity) found.set(id, { entity, owner });
    };
    const passes = (def: S.FieldDef, v: unknown, k: unknown) =>
      def.owns_when === undefined || truthy(run(compiled.formula(def.owns_when), { v, k }));
    // `owner` is the nearest list row / map value above a ref, or the ref itself
    const walk = (def: S.FieldDef, value: unknown, key: unknown, owner: unknown) => {
      if (def.owns === false || value === null || value === undefined) return;
      const collection = def.type === 'list' || def.type === 'map';
      // owns_when gates a value; on a list or map it gates each element instead
      if (!collection && !passes(def, value, key)) return;
      if (def.type === 'ref') { add(value, owner ?? value); return; }
      if (def.type === 'object') { if (isPlain(value)) for (const sub of def.fields ?? []) walk(sub, value[sub.key], sub.key, owner); return; }
      if (!collection) return;
      const elements: [string | number, unknown][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : isPlain(value) ? Object.entries(value) : [];
      for (const [k, v] of elements) {
        if (!passes(def, v, k)) continue;
        if (def.type === 'map' && def.key_entity_type) add(String(k), v);
        if (def.of === 'ref') add(v, v);
        if (def.of === 'object' && isPlain(v)) for (const sub of def.fields ?? []) walk(sub, v[sub.key], sub.key, v);
      }
    };
    for (const def of compiled.fields) walk(def, state[def.key], def.key, undefined);
    // grants: follow until nothing new is added
    const queue = [...found.values()];
    while (queue.length) {
      const o = queue.shift()!;
      for (const g of o.entity.grants) {
        if (found.has(g.entity)) continue;
        const vars = entityVars(o);
        if (g.gate && !truthy(run(g.gate, vars))) continue;
        if (g.when && !truthy(run(g.when, vars))) continue;
        add(g.entity, o.entity.envelope);
        queue.push(found.get(g.entity)!);
      }
    }
    return [...found.values()];
  }

  let featureCache: ActiveFeature[] | undefined;
  function features(): ActiveFeature[] {
    if (featureCache) return featureCache;
    featureCache = owned().flatMap((o) =>
      o.entity.features
        .filter((ft) => !ft.when || truthy(run(ft.when, entityVars(o))))
        .map((ft) => {
          // feature prose is text: rendered with $self/$owner of the entity that has it
          const prose = (src?: string) => (src ? String(run(compiled.template(src), entityVars(o)) ?? '') : null);
          return { id: ft.id, name: ft.name, summary: prose(ft.summary), description: prose(ft.description), source: ft.source, resource: ft.resource ?? null, actions: ft.actions };
        }),
    );
    return featureCache;
  }

  // ----- modifiers -----
  function applyModifiers(rootName: string, value: unknown): unknown {
    if (!compiled.modTargets.has(rootName)) return value;
    const byLeaf = new Map<string, { keys: (string | number)[]; mods: { m: CModifier; value: number | null }[] }>();
    for (const o of owned()) {
      const vars = entityVars(o);
      for (const m of o.entity.modifiers) {
        if (m.root !== rootName) continue;
        if (m.gate && !truthy(run(m.gate, vars))) continue;
        if (m.when && !truthy(run(m.when, vars))) continue;
        const keys = concretePath(m.path.slice(1), vars);
        if (!keys) continue;
        // a target that names a collection applies to every entry in it
        const leaves = keys.length === 0 && isPlain(value) ? Object.keys(value).map((k) => [k]) : [keys];
        const raw = run(m.value, vars);
        const num = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
        if (raw !== null && num === null) warn(`${m.at}: modifier value is not a number`);
        for (const leaf of leaves) {
          const id = leaf.join('.');
          const entry = byLeaf.get(id) ?? { keys: leaf, mods: [] };
          entry.mods.push({ m, value: num });
          byLeaf.set(id, entry);
        }
      }
    }
    if (byLeaf.size === 0) return value;
    let out = clone(value);
    for (const [id, { keys, mods }] of byLeaf) {
      const base = keys.length ? getIn(out, keys) : out;
      if (keys.length && base === undefined) { warn(`modifier target ${rootName}.${id} does not exist`); continue; }
      const result = combine(base ?? null, mods);
      breakdowns.set(keys.length ? `${rootName}.${id}` : rootName, { base: base ?? null, value: result.value, contributions: result.contributions });
      out = keys.length ? setIn(out, keys, result.value) : result.value;
    }
    return out;
  }

  function concretePath(segs: PathSeg[], vars: Record<string, unknown>): (string | number)[] | null {
    const keys: (string | number)[] = [];
    for (const s of segs) {
      const k = typeof s === 'string' ? s : run(s, vars);
      if (typeof k !== 'string' && typeof k !== 'number') return null;
      keys.push(k);
    }
    return keys;
  }

  function combine(base: unknown, mods: { m: CModifier; value: number | null }[]): { value: unknown; contributions: Contribution[] } {
    const contributions: Contribution[] = mods.map(({ m, value }) => ({ source: m.source, op: m.op, type: m.type ?? null, value, applied: false }));
    const byOp = (op: CModifier['op']) => contributions.filter((c) => c.op === op && c.value !== null);
    let v: number | null = typeof base === 'number' ? base : null;
    const sets = byOp('set');
    if (sets.length) {
      const best = sets.reduce((a, b) => (b.value! > a.value! ? b : a));
      best.applied = true;
      v = best.value;
    }
    // only the winning max/min counts as applied
    const maxes = byOp('max');
    if (maxes.length) {
      const best = maxes.reduce((a, b) => (b.value! > a.value! ? b : a));
      if (v === null || best.value! > v) { v = best.value; best.applied = true; }
    }
    const mins = byOp('min');
    if (mins.length) {
      const best = mins.reduce((a, b) => (b.value! < a.value! ? b : a));
      if (v === null || best.value! < v) { v = best.value; best.applied = true; }
    }
    const adds = byOp('add');
    if (adds.length && v !== null) {
      const groups = new Map<string, Contribution[]>();
      for (const c of adds) {
        const list = groups.get(c.type ?? '');
        if (list) list.push(c);
        else groups.set(c.type ?? '', [c]);
      }
      for (const [type, list] of groups) {
        if ((compiled.modifierTypes.get(type) ?? 'sum') === 'sum') {
          for (const c of list) { v += c.value!; c.applied = true; }
          continue;
        }
        // highest: best bonus and worst penalty, resolved separately
        const bonus = list.filter((c) => c.value! > 0).sort((a, b) => b.value! - a.value!)[0];
        const penalty = list.filter((c) => c.value! < 0).sort((a, b) => a.value! - b.value!)[0];
        for (const c of [bonus, penalty]) if (c) { v += c.value!; c.applied = true; }
      }
    }
    return { value: v === null && typeof base !== 'number' && !sets.length ? base : v, contributions };
  }

  // ----- resources -----
  let resourceCache: ResourceState[] | undefined;
  function resources(): ResourceState[] {
    if (resourceCache) return resourceCache;
    resourceCache = [];
    for (const r of compiled.resources) resourceCache.push(resourceState(r.id, r.label, r.max, r.reset, r.temp, undefined));
    for (const o of owned()) {
      for (const r of o.entity.resources) {
        if (r.gate && !truthy(run(r.gate, entityVars(o)))) continue;
        resourceCache.push(resourceState(r.id, r.label, r.max, r.reset, r.temp, entityVars(o)));
      }
    }
    return resourceCache;
  }
  function resourceState(id: string, label: string, maxAst: Ast, reset: string[], temp: boolean, vars?: Record<string, unknown>): ResourceState {
    const res = isPlain(state.res) ? state.res : {};
    const entry = isPlain(res[id]) ? res[id] : {};
    let cachedMax: number | null | undefined;
    const max = () => {
      if (cachedMax === undefined) { const m = run(maxAst, vars); cachedMax = typeof m === 'number' ? m : null; }
      return cachedMax;
    };
    // getters keep @res.x.current from evaluating max formulas it doesn't need
    return {
      id, label, reset,
      get max() { return max(); },
      get current() {
        const stored = entry.current;
        const m = max();
        const c = typeof stored === 'number' ? stored : m;
        return c === null ? null : m === null ? Math.max(0, c) : Math.min(m, Math.max(0, c));
      },
      get temp() {
        if (!temp) return null;
        const t = entry.temp;
        return typeof t === 'number' ? Math.max(0, t) : 0;
      },
    };
  }
  function resObject(): Record<string, ResourceState> {
    return (resCache ??= Object.fromEntries(resources().map((r) => [r.id, r])));
  }

  /** Public entry points: a formula error (cycle, budget) becomes a warning instead of a throw. */
  function guard<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      warn(e.message);
      return fallback;
    }
  }

  return {
    compiled,
    state,
    eval: (src, vars) => run(compiled.formula(src), vars),
    text: (src, vars) => String(run(compiled.template(src), vars) ?? ''),
    ctx,
    root: (n) => guard(() => root(n), null),
    owned: () => guard(owned, []),
    features: () => guard(features, []),
    resources: () => guard(resources, []),
    explain(path) {
      guard(() => root(path.split('.')[0]), null);
      return breakdowns.get(path);
    },
    violations: () => compiled.constraints.filter((c) => truthy(run(c.violated))).map((c) => ({ id: c.id, message: c.message })),
    warnings,
  };
}

export function getIn(obj: unknown, keys: (string | number)[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (Array.isArray(cur) && typeof k === 'number') cur = cur[k];
    else if (isPlain(cur) && Object.hasOwn(cur, String(k))) cur = cur[String(k)];
    else return undefined;
  }
  return cur;
}

function setIn(obj: unknown, keys: (string | number)[], value: unknown): unknown {
  if (keys.length === 0) return value;
  const [k, ...rest] = keys;
  if (Array.isArray(obj) && typeof k === 'number') {
    const copy = [...obj];
    copy[k] = setIn(copy[k], rest, value);
    return copy;
  }
  const base = isPlain(obj) ? obj : {};
  return { ...base, [k]: setIn(base[String(k)], rest, value) };
}
