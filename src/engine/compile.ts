// Merged pack set → Compiled: every formula parsed once, references and dependency graph checked.
// See docs/SPEC.md → How the model runs, Grants, Modifiers, Paths.
import { analyze, type Ast, FormulaError, FormulaValue, parse, parseTemplate, parseValue, type Table } from './formula';
import type { Issue, Located } from './load';
import type { MergedPack } from './merge';
import type * as S from './schema';

export const RESERVED = ['res', 'name', 'base', 'features', 'owned'];
const VARS = ['input', 'steps', 'choice', 'self', 'owner', 'v', 'k'];

export type PathSeg = string | Ast;

export interface CModifier {
  path: PathSeg[];
  root: string;
  op: 'set' | 'add' | 'max' | 'min';
  value: Ast;
  when?: Ast;
  /** the enclosing feature's `when` */
  gate?: Ast;
  type?: string;
  source: string;
  at: string;
}
export interface CResource {
  id: string;
  label: string;
  max: Ast;
  reset: string[];
  temp: boolean;
  gate?: Ast;
  at: string;
}
export interface CGrant {
  entity: string;
  when?: Ast;
  gate?: Ast;
}
export interface CFeature {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  when?: Ast;
  resource?: string;
  actions: string[];
  source: string;
}
export interface CEntity {
  id: string;
  type: string;
  /** what formulas see as `$self` / `entity(id)` / `$v` in filters */
  envelope: Record<string, unknown>;
  modifiers: CModifier[];
  features: CFeature[];
  resources: CResource[];
  grants: CGrant[];
  hooks: Record<string, Record<string, S.Effect[]>>;
  at: string;
}
export interface CDerived {
  id: string;
  formula: Ast;
  each?: string;
  eachType?: string;
}

export interface Compiled {
  manifest: S.Manifest;
  packs: { id: string; version: string }[];
  fields: S.FieldDef[];
  fieldByKey: Map<string, S.FieldDef>;
  derived: Map<string, CDerived>;
  resources: CResource[];
  modifierTypes: Map<string, 'sum' | 'highest'>;
  constraints: { id: string; violated: Ast; message: string }[];
  tables: Map<string, Table>;
  entityTypes: Map<string, S.EntityType>;
  entities: Map<string, CEntity>;
  byType: Map<string, CEntity[]>;
  actions: Map<string, S.Action>;
  modals: Map<string, S.Modal>;
  creation?: { steps: S.Step[] };
  sheet: S.Sheet;
  /** in `sheet.tabs` order */
  tabs: S.Tab[];
  /** roots that at least one modifier targets */
  modTargets: Set<string>;
  /** parsed formula for a source string that compile() has seen */
  formula(src: S.FormulaSrc): Ast;
  path(src: string): PathSeg[];
  /** parsed text template (`"Level {@level}"`) */
  template(src: string): Ast;
  /** `<pack>:<file>#<pointer>` of the first place a formula appears, for runtime warnings */
  locate(ast: Ast): string | undefined;
}

export function parsePath(src: string): PathSeg[] {
  let n = parse(`@${src}`);
  const segs: PathSeg[] = [];
  while (n.t === 'get') { segs.unshift(n.key); n = n.obj; }
  if (n.t !== 'ref') throw new FormulaError(`'${src}' is not a path`);
  return [n.name, ...segs];
}

export function compile(merged: MergedPack): { compiled?: Compiled; issues: Issue[] } {
  const issues: Issue[] = [];
  const err = (at: string, message: string) => issues.push({ level: 'error', at, message });
  const warn = (at: string, message: string) => issues.push({ level: 'warning', at, message });

  const formulas = new Map<string, Ast>();
  const locations = new WeakMap<Ast, string>();
  const paths = new Map<string, PathSeg[]>();
  const fields = merged.character?.v.fields ?? [];
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));
  const derivedIds = new Set(merged.derived.map((d) => d.v.id));
  const entityTypes = new Map(merged.entityTypes.map((t) => [t.v.id, t.v]));
  const entityTypeOf = new Map(merged.entities.map((e) => [e.v.id, e.v.type]));
  const entityIds = new Set(entityTypeOf.keys());
  const tableIds = new Set(merged.tables.map((t) => t.v.id));
  const modalIds = new Set(merged.modals.map((m) => m.v.id));
  const actionIds = new Set(merged.actions.map((a) => a.v.id));
  const modifierTypes = new Map(merged.modifierTypes.map((t) => [t.v.id, t.v.stacking]));

  // dependency graph over roots: field keys, derived ids, `res.<id>`, `features` and `owned`
  const deps = new Map<string, Set<string>>();
  const edge = (node: string, on: Iterable<string>) => {
    const set = deps.get(node) ?? new Set();
    for (const o of on) set.add(o);
    deps.set(node, set);
  };
  const resourceIds = new Set<string>();
  const resourceTemp = new Map<string, boolean>();
  /** formulas that settle ownership: may not read anything a modifier can change, nor ownership itself */
  const ownershipFormulas: { ast: Ast; at: string }[] = [];

  for (const key of ['entityTypes', 'derived', 'resources', 'modifierTypes', 'constraints', 'tables', 'entities', 'tabs', 'actions', 'modals'] as const) {
    const seen = new Map<string, string>();
    for (const item of merged[key] as Located<{ id: string }>[]) {
      const prev = seen.get(item.v.id);
      if (prev) err(item.at, `duplicate id '${item.v.id}' (also at ${prev})`);
      seen.set(item.v.id, item.at);
    }
  }
  if (merged.manifest.kind === 'major' && !merged.creation) err(`${merged.manifest.id}:ui/creation.json`, 'a major pack needs ui/creation.json');

  // ----- formulas -----
  function f(src: S.FormulaSrc | undefined, at: string): Ast | undefined {
    if (src === undefined) return undefined;
    const cacheKey = JSON.stringify(src);
    let ast = formulas.get(cacheKey);
    if (!ast) {
      try {
        ast = parseValue(src);
      } catch (e) {
        err(at, `formula: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
      formulas.set(cacheKey, ast);
      locations.set(ast, at);
    }
    checkAst(ast, at);
    return ast;
  }
  const templates = new Map<string, Ast>();
  /** check a text field: literal text with {formula} parts */
  function t(src: string, at: string): Ast | undefined {
    let ast = templates.get(src);
    if (!ast) {
      try {
        ast = parseTemplate(src);
      } catch (e) {
        err(at, `text: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
      templates.set(src, ast);
      locations.set(ast, at);
    }
    checkAst(ast, at);
    return ast;
  }
  function checkAst(ast: Ast, at: string) {
    const a = analyze(ast);
    for (const [root] of a.refs) {
      if (!fieldByKey.has(root) && !derivedIds.has(root) && !RESERVED.includes(root)) err(at, `unknown reference @${root}`);
    }
    for (const v of a.vars) if (!VARS.includes(v)) err(at, `unknown variable $${v}`);
    for (const c of a.calls) {
      const lit = c.args[0]?.t === 'lit' ? c.args[0].v : undefined;
      if (typeof lit !== 'string') continue;
      if (c.fn === 'lookup' && !tableIds.has(lit)) err(at, `unknown table '${lit}'`);
      if (c.fn === 'entities' && !entityTypes.has(lit)) err(at, `unknown entity type '${lit}'`);
      if (c.fn === 'entity' && !entityIds.has(lit)) err(at, `unknown entity '${lit}'`);
    }
  }
  /** dependency nodes a formula reads */
  function nodesOf(ast: Ast | undefined): string[] {
    if (!ast) return [];
    const out: string[] = [];
    for (const [root, a] of analyze(ast).refs) {
      if (root === 'base' || root === 'name') continue;
      // current is clamped to max, so reading any part of a resource depends on its max
      if (root === 'res') out.push(...(a === undefined ? [...resourceIds].map((r) => `res.${r}`) : [`res.${a}`]));
      else out.push(root);
    }
    return out;
  }
  function p(src: string, at: string, mode: 'write' | 'target'): PathSeg[] | undefined {
    let segs = paths.get(src);
    if (!segs) {
      try {
        segs = parsePath(src);
      } catch (e) {
        err(at, `path: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
      paths.set(src, segs);
    }
    for (const s of segs) if (typeof s !== 'string') checkAst(s, at);
    const root = segs[0] as string;
    if (mode === 'write' && !fieldByKey.has(root) && root !== 'res') err(at, `cannot write to '${root}' (only stored fields and res)`);
    if (mode === 'write' && root === 'res') {
      const [, id, part] = segs;
      if (segs.length !== 3 || (part !== 'current' && part !== 'temp')) err(at, 'resource writes must be res.<id>.current or res.<id>.temp');
      else if (typeof id === 'string' && !resourceIds.has(id)) err(at, `unknown resource '${id}'`);
      else if (typeof id === 'string' && part === 'temp' && !resourceTemp.get(id)) err(at, `resource '${id}' has no temp value`);
    }
    if (mode === 'target') {
      if (!fieldByKey.has(root) && !derivedIds.has(root)) err(at, `modifier target '${root}' is not a field or derived value`);
      const field = fieldByKey.get(root);
      if (field && !['number', 'object', 'map', 'list'].includes(field.type)) err(at, `modifier target '${root}' is not numeric`);
    }
    return segs;
  }

  // ----- character fields -----
  function checkField(fd: S.FieldDef, at: string, inEntityType: boolean) {
    if (fd.type === 'formula' && !inEntityType) err(at, `'${fd.key}': formula fields are only allowed on entity types`);
    if (fd.type === 'select' && !fd.options?.length) err(at, `'${fd.key}': select needs options`);
    const needsType = fd.type === 'ref' || ((fd.type === 'list' || fd.type === 'map') && fd.of === 'ref');
    if (needsType && !fd.entity_type) err(at, `'${fd.key}': needs entity_type`);
    if (fd.entity_type && !entityTypes.has(fd.entity_type)) err(at, `'${fd.key}': unknown entity type '${fd.entity_type}'`);
    if (fd.type === 'map' && fd.key_entity_type && !entityTypes.has(fd.key_entity_type)) err(at, `'${fd.key}': unknown entity type '${fd.key_entity_type}'`);
    if ((fd.type === 'list' || fd.type === 'map') && !fd.of) err(at, `'${fd.key}': ${fd.type} needs "of"`);
    if ((fd.type === 'object' || fd.of === 'object') && !fd.fields) err(at, `'${fd.key}': needs "fields"`);
    fd.fields?.forEach((sub, i) => checkField(sub, `${at}/fields/${i}`, inEntityType));
    if (fd.owns_when !== undefined) {
      const ast = f(fd.owns_when, `${at}/owns_when`);
      if (ast) ownershipFormulas.push({ ast, at: `${at}/owns_when` });
    }
  }
  merged.character?.v.fields.forEach((fd, i) => {
    const at = `${merged.character!.at}#/fields/${i}`;
    if (RESERVED.includes(fd.key)) err(at, `'${fd.key}' is a reserved name`);
    if (derivedIds.has(fd.key)) err(at, `'${fd.key}' is both a field and a derived value`);
    checkField(fd, at, false);
  });
  for (const t of merged.entityTypes) t.v.fields.forEach((fd, i) => checkField(fd, `${t.at}/fields/${i}`, true));

  // ----- resources (ids are global: they live under res.<id>) -----
  const seenResources = new Map<string, string>();
  function resource(r: S.ResourceDef, at: string, gate?: Ast): CResource {
    const prev = seenResources.get(r.id);
    if (prev) err(at, `resource '${r.id}' is already declared at ${prev}`);
    seenResources.set(r.id, at);
    resourceIds.add(r.id);
    const max = f(r.max, `${at}/max`) ?? { t: 'lit', v: null };
    return { id: r.id, label: r.label, max, reset: r.reset ?? [], temp: r.temp ?? false, gate, at };
  }
  // collect ids first so @res references resolve regardless of order
  for (const r of [
    ...merged.resources.map((x) => x.v),
    ...merged.entities.flatMap((e) => [...(e.v.resources ?? []), ...(e.v.features ?? []).flatMap((ft) => ft.resources ?? [])]),
  ]) {
    resourceIds.add(r.id);
    resourceTemp.set(r.id, r.temp ?? false);
  }
  const modelResources = merged.resources.map((r) => resource(r.v, r.at));

  // ----- entities -----
  const modTargets = new Set<string>();
  function modifier(m: S.Modifier, at: string, source: string, gate?: Ast): CModifier | undefined {
    const path = p(m.target, `${at}/target`, 'target');
    const value = f(m.value, `${at}/value`);
    const when = f(m.when, `${at}/when`);
    if (m.type && !modifierTypes.has(m.type)) err(`${at}/type`, `unknown modifier type '${m.type}' (declare it in model/modifier-types.json)`);
    if (!path || !value) return undefined;
    const root = path[0] as string;
    modTargets.add(root);
    const keyNodes = path.slice(1).flatMap((s) => (typeof s === 'string' ? [] : nodesOf(s)));
    // modifiers exist because their entity is owned
    edge(root, ['owned', ...keyNodes, ...nodesOf(value), ...nodesOf(when), ...nodesOf(gate)]);
    return { path, root, op: m.op, value, when, gate, type: m.type, source, at };
  }
  function grant(g: S.Grant, at: string, gate?: Ast): CGrant {
    if (!entityIds.has(g.entity)) err(`${at}/entity`, `unknown entity '${g.entity}'`);
    const when = f(g.when, `${at}/when`);
    if (when) ownershipFormulas.push({ ast: when, at: `${at}/when` });
    if (gate) ownershipFormulas.push({ ast: gate, at: `${at} (feature when)` });
    return { entity: g.entity, when, gate };
  }

  const entities = new Map<string, CEntity>();
  const byType = new Map<string, CEntity[]>();
  const featureWhens: Ast[] = [];
  for (const { v: e, at } of merged.entities) {
    const type = entityTypes.get(e.type);
    if (!type) { err(at, `content/${e.type}/ is not a declared entity type`); continue; }
    const data = checkData(e.data ?? {}, type.fields, `${at}/data`);
    const envelope = { id: e.id, type: e.type, name: e.name, summary: e.summary ?? null, description: e.description ?? null, image: e.image ?? null, data };
    const ce: CEntity = {
      id: e.id, type: e.type, envelope, at,
      modifiers: (e.modifiers ?? []).map((m, i) => modifier(m, `${at}/modifiers/${i}`, e.id)).filter((m) => m !== undefined),
      resources: (e.resources ?? []).map((r, i) => resource(r, `${at}/resources/${i}`)),
      grants: (e.grants ?? []).map((g, i) => grant(g, `${at}/grants/${i}`)),
      features: [],
      hooks: e.hooks ?? {},
    };
    (e.features ?? []).forEach((ft, i) => {
      const fat = `${at}/features/${i}`;
      const when = f(ft.when, `${fat}/when`);
      if (when) featureWhens.push(when);
      for (const a of ft.actions ?? []) if (!actionIds.has(a)) err(`${fat}/actions`, `unknown action '${a}'`);
      if (ft.resource && !resourceIds.has(ft.resource)) err(`${fat}/resource`, `unknown resource '${ft.resource}'`);
      ce.features.push({ id: ft.id, name: ft.name, summary: ft.summary, description: ft.description, when, resource: ft.resource, actions: ft.actions ?? [], source: e.id });
      (ft.modifiers ?? []).forEach((m, j) => { const cm = modifier(m, `${fat}/modifiers/${j}`, e.id, when); if (cm) ce.modifiers.push(cm); });
      (ft.resources ?? []).forEach((r, j) => ce.resources.push(resource(r, `${fat}/resources/${j}`, when)));
      (ft.grants ?? []).forEach((g, j) => ce.grants.push(grant(g, `${fat}/grants/${j}`, when)));
    });
    for (const [hook, byKey] of Object.entries(ce.hooks)) {
      for (const [key, effects] of Object.entries(byKey)) checkEffects(effects, `${at}/hooks/${hook}/${key}`);
    }
    entities.set(e.id, ce);
    const list = byType.get(e.type);
    if (list) list.push(ce);
    else byType.set(e.type, [ce]);
  }
  edge('features', ['owned', ...featureWhens.flatMap(nodesOf)]);

  function checkData(data: Record<string, unknown>, defs: S.FieldDef[], at: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const byKey = new Map(defs.map((d) => [d.key, d]));
    for (const [k, v] of Object.entries(data)) {
      const def = byKey.get(k);
      if (!def) { warn(`${at}/${k}`, `'${k}' is not declared on this entity type`); out[k] = v; continue; }
      out[k] = checkValue(v, def, `${at}/${k}`);
    }
    return out;
  }
  function checkValue(v: unknown, def: S.FieldDef, at: string, type = def.type): unknown {
    if (v === null) return null;
    switch (type) {
      case 'formula': {
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') { err(at, 'expected a formula'); return null; }
        const ast = f(v, at);
        return ast ? new FormulaValue(String(v), ast) : null;
      }
      case 'number': if (typeof v !== 'number') err(at, 'expected a number'); return v;
      case 'boolean': if (typeof v !== 'boolean') err(at, 'expected true or false'); return v;
      case 'string': case 'text': if (typeof v !== 'string') err(at, 'expected a string'); return v;
      case 'select': if (!def.options?.includes(String(v))) err(at, `expected one of ${def.options?.join(', ')}`); return v;
      case 'ref':
        if (typeof v !== 'string' || !entityIds.has(v)) err(at, `unknown entity '${String(v)}'`);
        else if (def.entity_type && entityTypeOf.get(v) !== def.entity_type) err(at, `'${v}' is not a ${def.entity_type}`);
        return v;
      case 'list':
        if (!Array.isArray(v)) { err(at, 'expected a list'); return v; }
        return v.map((x, i) => checkValue(x, def, `${at}/${i}`, def.of ?? 'string'));
      case 'object': case 'map':
        if (!v || typeof v !== 'object' || Array.isArray(v)) { err(at, 'expected an object'); return v; }
        return type === 'object' ? checkData(v as Record<string, unknown>, def.fields ?? [], at) : v;
    }
    return v;
  }

  // ----- effects -----
  function checkEffects(effects: S.Effect[], at: string) {
    effects.forEach((e, i) => {
      const eat = `${at}/${i}`;
      switch (e.op) {
        case 'set': case 'push': p(e.path, `${eat}/path`, 'write'); f(e.value, `${eat}/value`); break;
        case 'add': p(e.path, `${eat}/path`, 'write'); f(e.value, `${eat}/value`); f(e.min, `${eat}/min`); f(e.max, `${eat}/max`); break;
        case 'remove': p(e.path, `${eat}/path`, 'write'); f(e.where, `${eat}/where`); break;
        case 'toggle': p(e.path, `${eat}/path`, 'write'); f(e.value, `${eat}/value`); break;
        case 'choose': {
          if (!entityTypes.has(e.from.entity_type)) err(`${eat}/from/entity_type`, `unknown entity type '${e.from.entity_type}'`);
          f(e.from.filter, `${eat}/from/filter`);
          f(e.count, `${eat}/count`);
          const into = e.into ? p(e.into, `${eat}/into`, 'write') : undefined;
          const def = into && staticField(into);
          if (def && !((def.type === 'ref' || (def.type === 'list' && def.of === 'ref')) && def.entity_type === e.from.entity_type)) {
            err(`${eat}/into`, `'${e.into}' must be a ref or list of refs to ${e.from.entity_type}`);
          }
          if (e.then) checkEffects(e.then, `${eat}/then`);
          break;
        }
        case 'open_modal':
          if (!modalIds.has(e.modal)) err(`${eat}/modal`, `unknown modal '${e.modal}'`);
          for (const [k, v] of Object.entries(e.with ?? {})) f(v, `${eat}/with/${k}`);
          break;
        case 'run_hook': {
          const entity = f(e.entity, `${eat}/entity`);
          if (entity?.t === 'lit' && !entityIds.has(String(entity.v))) err(`${eat}/entity`, `unknown entity '${String(entity.v)}'`);
          f(e.key, `${eat}/key`);
          break;
        }
        case 'reset': break;
        case 'if': f(e.when, `${eat}/when`); checkEffects(e.then, `${eat}/then`); if (e.else) checkEffects(e.else, `${eat}/else`); break;
      }
    });
  }

  // ----- derived -----
  const derived = new Map<string, CDerived>();
  for (const { v: d, at } of merged.derived) {
    if (RESERVED.includes(d.id)) err(at, `'${d.id}' is a reserved name`);
    const formula = f(d.formula, `${at}/formula`);
    if (d.each && !fieldByKey.has(d.each)) err(`${at}/each`, `unknown field '${d.each}'`);
    if (d.each_type && !entityTypes.has(d.each_type)) err(`${at}/each_type`, `unknown entity type '${d.each_type}'`);
    if (!formula) continue;
    edge(d.id, [...nodesOf(formula), ...(d.each ? [d.each] : [])]);
    derived.set(d.id, { id: d.id, formula, each: d.each, eachType: d.each_type });
  }
  for (const r of [...modelResources, ...[...entities.values()].flatMap((e) => e.resources)]) edge(`res.${r.id}`, ['owned', ...nodesOf(r.max)]);

  /** The field a fully static path lands on, or undefined when a segment is computed or unknown. */
  function staticField(segs: PathSeg[]): S.FieldDef | undefined {
    if (segs.some((s) => typeof s !== 'string')) return undefined;
    let def = fieldByKey.get(segs[0] as string);
    for (const k of segs.slice(1)) {
      if (!def) return undefined;
      if (def.type === 'object') def = def.fields?.find((x) => x.key === k);
      else if (def.type === 'list' || def.type === 'map') def = def.of === 'object' ? { key: String(k), type: 'object', fields: def.fields } : { ...def, key: String(k), type: def.of ?? 'string' };
      else return undefined;
    }
    return def;
  }
  // ----- ui/: every field is text (a template) or a formula, by key; see SPEC → Text and formulas -----
  const TEXT_KEYS = new Set(['label', 'title', 'subtitle', 'body', 'empty', 'text', 'message', 'description']);
  const FORMULA_KEYS = new Set(['value', 'sub', 'source', 'group_by', 'when', 'visible_when', 'enabled_when', 'filter', 'default', 'at']);
  function checkUi(node: unknown, at: string) {
    if (Array.isArray(node)) { node.forEach((x, i) => checkUi(x, `${at}/${i}`)); return; }
    if (!node || typeof node !== 'object') return;
    const ref = (set: Set<string>, kind: string, v: unknown, vat: string) => { if (!set.has(String(v))) err(vat, `unknown ${kind} '${String(v)}'`); };
    for (const [k, v] of Object.entries(node)) {
      const kat = `${at}/${k}`;
      if (k === 'effects' && Array.isArray(v)) checkEffects(v as S.Effect[], kat);
      else if (TEXT_KEYS.has(k) && typeof v === 'string') t(v, kat);
      else if (FORMULA_KEYS.has(k) || (k === 'options' && typeof v === 'string')) f(v as S.FormulaSrc, kat);
      else if (k === 'actions' && Array.isArray(v)) v.forEach((a, i) => ref(actionIds, 'action', a, `${kat}/${i}`));
      else if ((k === 'action' || k === 'add') && typeof v === 'string') ref(actionIds, 'action', v, kat);
      else if (k === 'modal' && typeof v === 'string') ref(modalIds, 'modal', v, kat);
      else if (k === 'resource' && typeof v === 'string') ref(resourceIds, 'resource', v, kat);
      else if (k === 'entity_type' && typeof v === 'string') ref(new Set(entityTypes.keys()), 'entity type', v, kat);
      else if (k === 'explain' && typeof v === 'string') p(v, kat, 'target');
      else if (k === 'path' && typeof v === 'string') p(v, kat, 'write');
      else checkUi(v, kat);
    }
    if ('type' in node && node.type === 'choice' && !('entity_type' in node)) err(at, 'a choice input needs entity_type');
  }

  // ----- constraints, ui -----
  const constraints = merged.constraints.flatMap(({ v: c, at }) => {
    const violated = f(c.violated_when, `${at}/violated_when`);
    t(c.message, `${at}/message`);
    return violated ? [{ id: c.id, violated, message: c.message }] : [];
  });
  for (const { v, at } of [...merged.actions, ...merged.modals, ...merged.tabs]) checkUi(v, at);
  if (merged.sheet) checkUi(merged.sheet.v, `${merged.sheet.at}#`);
  if (merged.creation) checkUi(merged.creation.v, `${merged.creation.at}#`);
  for (const { v: e, at } of merged.entities) {
    if (e.summary) t(e.summary, `${at}/summary`);
    if (e.description) t(e.description, `${at}/description`);
    e.features?.forEach((ft, i) => {
      if (ft.summary) t(ft.summary, `${at}/features/${i}/summary`);
      if (ft.description) t(ft.description, `${at}/features/${i}/description`);
    });
  }

  // assets: references must name a file the packs ship
  const assets = new Set(merged.packs.flatMap((pk) => pk.assets));
  if (merged.manifest.icon && !assets.has(merged.manifest.icon)) err(`${merged.manifest.id}:manifest.json#/icon`, `no such asset '${merged.manifest.icon}'`);
  for (const { v: e, at } of merged.entities) if (e.image && !assets.has(e.image)) err(`${at}/image`, `no such asset '${e.image}'`);
  const tabIds = new Set(merged.tabs.map((x) => x.v.id));
  const listed = new Set(merged.sheet?.v.tabs ?? []);
  merged.sheet?.v.tabs.forEach((x, i) => { if (!tabIds.has(x)) err(`${merged.sheet!.at}#/tabs/${i}`, `unknown tab '${x}'`); });
  for (const x of merged.tabs) if (!listed.has(x.v.id)) warn(x.at, `tab '${x.v.id}' is not listed in ui/sheet.json`);

  // ownership is settled from the ownership formulas
  edge('owned', ownershipFormulas.flatMap(({ ast }) => nodesOf(ast)));

  // ----- ownership may not read anything a modifier can change -----
  const modDependent = new Set<string>();
  const reaches = (n: string, seen = new Set<string>()): boolean => {
    if (modTargets.has(n)) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    return [...(deps.get(n) ?? [])].some((d) => reaches(d, seen));
  };
  for (const n of [...deps.keys(), ...modTargets]) if (reaches(n)) modDependent.add(n);
  let ownershipErrors = 0;
  for (const { ast, at } of ownershipFormulas) {
    const nodes = nodesOf(ast);
    const self = [...new Set(nodes.filter((n) => n === 'owned' || n === 'features' || n.startsWith('res.')))];
    const bad = nodes.filter((n) => modDependent.has(n));
    if (self.length) err(at, `ownership can't read ${self.map((b) => `@${b}`).join(', ')} (it depends on ownership); read @base.* instead`);
    else if (bad.length) err(at, `ownership can't depend on values modifiers change (${bad.map((b) => `@${b}`).join(', ')}); read @base.* instead`);
    else continue;
    ownershipErrors++;
  }

  // ----- dependency cycles (those through ownership are already reported above) -----
  const state = new Map<string, 'active' | 'done'>();
  const stack: string[] = [];
  const visit = (n: string) => {
    if (state.get(n) === 'done') return;
    if (state.get(n) === 'active') {
      const cycle = [...stack.slice(stack.indexOf(n)), n];
      if (!(ownershipErrors && cycle.includes('owned'))) err(merged.packs[0].manifest.id, `dependency cycle: ${cycle.join(' → ')}`);
      return;
    }
    state.set(n, 'active');
    stack.push(n);
    for (const d of deps.get(n) ?? []) visit(d);
    stack.pop();
    state.set(n, 'done');
  };
  for (const n of deps.keys()) visit(n);

  // ----- grant cycles -----
  const gstate = new Map<string, 'active' | 'done'>();
  const gstack: string[] = [];
  const gvisit = (id: string) => {
    if (gstate.get(id) === 'done') return;
    if (gstate.get(id) === 'active') { err(entities.get(id)?.at ?? id, `grant cycle: ${[...gstack.slice(gstack.indexOf(id)), id].join(' → ')}`); return; }
    gstate.set(id, 'active');
    gstack.push(id);
    for (const g of entities.get(id)?.grants ?? []) gvisit(g.entity);
    gstack.pop();
    gstate.set(id, 'done');
  };
  for (const id of entities.keys()) gvisit(id);

  if (issues.some((i) => i.level === 'error')) return { issues };
  const compiled: Compiled = {
    manifest: merged.manifest,
    packs: merged.packs.map((pk) => ({ id: pk.manifest.id, version: pk.manifest.version })),
    fields, fieldByKey, derived, resources: modelResources, modifierTypes, constraints,
    tables: new Map(merged.tables.map((t) => [t.v.id, t.v])),
    entityTypes, entities, byType,
    actions: new Map(merged.actions.map((a) => [a.v.id, a.v])),
    modals: new Map(merged.modals.map((m) => [m.v.id, m.v])),
    creation: merged.creation?.v,
    sheet: merged.sheet?.v ?? { tabs: [] },
    tabs: (merged.sheet?.v.tabs ?? []).map((id) => merged.tabs.find((x) => x.v.id === id)!.v),
    modTargets,
    locate: (ast) => locations.get(ast),
    formula(src) {
      const key = JSON.stringify(src);
      let ast = formulas.get(key);
      if (!ast) { ast = parseValue(src); formulas.set(key, ast); }
      return ast;
    },
    template(src) {
      let ast = templates.get(src);
      if (!ast) { ast = parseTemplate(src); templates.set(src, ast); }
      return ast;
    },
    path(src) {
      let segs = paths.get(src);
      if (!segs) { segs = parsePath(src); paths.set(src, segs); }
      return segs;
    },
  };
  return { compiled, issues };
}
