// Major + expansions → one pack set; patches as JSON Merge Patch with arrays merged by id/key.
// See docs/SPEC.md → Expansions, Resolution.
import semver from 'semver';

import { type Issue, type Located, PART_SCHEMAS, type RawPack } from './load';

export interface Pin {
  id: string;
  range: string;
}
export interface CharacterPins {
  major: Pin;
  expansions: Pin[];
}
export interface Installed {
  id: string;
  version: string;
}

/** Newest installed version satisfying each pin, or the pins that can't be satisfied. */
export function resolvePins(pins: CharacterPins, installed: Installed[]): { resolved: Installed[]; missing: Pin[] } {
  const resolved: Installed[] = [];
  const missing: Pin[] = [];
  for (const pin of [pins.major, ...pins.expansions]) {
    const version = semver.maxSatisfying(installed.filter((p) => p.id === pin.id).map((p) => p.version), pin.range);
    if (version) resolved.push({ id: pin.id, version });
    else missing.push(pin);
  }
  return { resolved, missing };
}

export const resolutionKey = (packs: Installed[]) => packs.map((p) => `${p.id}@${p.version}`).join('+');

type CollectionKey = 'entityTypes' | 'derived' | 'resources' | 'modifierTypes' | 'constraints' | 'tables' | 'entities' | 'tabs' | 'actions' | 'modals';
// patch target prefix → collection
const TARGETS: Record<string, CollectionKey> = {
  entity_type: 'entityTypes', derived: 'derived', resource: 'resources', modifier_type: 'modifierTypes',
  constraint: 'constraints', table: 'tables', entity: 'entities', tab: 'tabs', action: 'actions', modal: 'modals',
};
const COLLECTIONS = Object.values(TARGETS);
const SINGLETONS = ['character', 'sheet', 'creation'] as const;

export type MergedPack = Omit<RawPack, 'patches'> & { packs: RawPack[] };

export function mergePacks(major: RawPack, expansions: RawPack[]): { merged?: MergedPack; issues: Issue[] } {
  const issues: Issue[] = [];
  const err = (at: string, message: string) => issues.push({ level: 'error', at, message });
  if (major.manifest.kind !== 'major') err(`${major.manifest.id}:manifest.json`, 'the first pack must be a major pack');
  const { patches: majorPatches, ...majorRest } = major;
  const merged: MergedPack = { ...structuredClone(majorRest), packs: [major, ...expansions] };
  for (const p of majorPatches) err(p.at, 'only expansions can contain patches');

  // which pack last patched each leaf, to report overlapping patches
  const patchedBy = new Map<string, string>();
  // `entity:fighter` → the item, so patches and collision checks don't scan lists
  const index = new Map<string, { item: Located<{ id: string }>; key: string }>();
  for (const key of COLLECTIONS) for (const item of merged[key] as Located<{ id: string }>[]) index.set(`${PREFIX[key]}:${item.v.id}`, { item, key });

  for (const exp of expansions) {
    const expId = exp.manifest.id;
    if (exp.manifest.kind !== 'expansion') { err(`${expId}:manifest.json`, 'only expansions can be added on top of a major pack'); continue; }
    if (exp.manifest.extends?.id !== major.manifest.id) {
      err(`${expId}:manifest.json#/extends`, `extends ${exp.manifest.extends?.id}, not ${major.manifest.id}`);
      continue;
    }
    if (!semver.satisfies(major.manifest.version, exp.manifest.extends.range)) {
      issues.push({ level: 'warning', at: `${expId}:manifest.json#/extends`, message: `needs ${major.manifest.id} ${exp.manifest.extends.range}, have ${major.manifest.version}` });
    }
    for (const s of SINGLETONS) if (exp[s]) err(exp[s]!.at, `expansions change ${s} through patches/, not by replacing it`);

    for (const key of COLLECTIONS) {
      const list = merged[key] as Located<{ id: string }>[];
      for (const item of exp[key] as Located<{ id: string }>[]) {
        const prev = index.get(`${PREFIX[key]}:${item.v.id}`);
        if (prev) { err(item.at, `id '${item.v.id}' already exists (${prev.item.at}); change existing items through patches/`); continue; }
        const copy = structuredClone(item);
        list.push(copy);
        index.set(`${PREFIX[key]}:${item.v.id}`, { item: copy, key });
      }
    }

    for (const patch of exp.patches) {
      const { target, merge } = patch.v;
      if (containsNull(merge)) { err(patch.at, 'patches cannot delete (null values are not allowed)'); continue; }
      if ('id' in merge || 'type' in merge) { err(patch.at, "patches cannot change an item's id or type"); continue; }
      const found = findTarget(target, patch.at);
      if (!found) { err(patch.at, `patch target '${target}' does not exist`); continue; }
      for (const leaf of leafPaths(merge, target)) {
        const prev = patchedBy.get(leaf);
        if (prev && prev !== expId) issues.push({ level: 'warning', at: patch.at, message: `${expId} and ${prev} both patch ${leaf}; ${expId} wins` });
        patchedBy.set(leaf, expId);
      }
      // the merged result must still be a valid item of its part
      const { type, ...value } = mergePatch(found.item.v, merge);
      const parsed = PART_SCHEMAS[found.key].safeParse(value);
      if (!parsed.success) {
        for (const i of parsed.error.issues) err(patch.at, `after patching ${target}: ${i.path.join('.') || '(item)'}: ${i.message}`);
        continue;
      }
      // the schema accepted it, so it has the item's shape
      const valid = parsed.data as Record<string, unknown>;
      found.item.v = found.key === 'entities' ? { ...valid, type } : valid;
    }
  }
  return { merged: issues.some((i) => i.level === 'error') ? undefined : merged, issues };

  function findTarget(target: string, at: string): { item: { v: Record<string, unknown> }; key: string } | undefined {
    if ((SINGLETONS as readonly string[]).includes(target)) {
      const s = target as (typeof SINGLETONS)[number];
      // a missing singleton starts from its empty default
      merged[s] ??= { v: structuredClone(EMPTY[s]), at } as never;
      return { item: merged[s] as unknown as { v: Record<string, unknown> }, key: s };
    }
    const hit = index.get(target);
    return hit && { item: hit.item as unknown as { v: Record<string, unknown> }, key: hit.key };
  }
}

const EMPTY = { character: { fields: [] }, sheet: { tabs: [] }, creation: { steps: [] } };
const PREFIX = Object.fromEntries(Object.entries(TARGETS).map(([prefix, key]) => [key, prefix])) as Record<CollectionKey, string>;

/** `entity:x.features[second_breath].name`-style paths of everything a patch sets, for overlap warnings. */
function leafPaths(patch: Record<string, unknown>, prefix: string, skip?: string): string[] {
  return Object.entries(patch).flatMap(([k, v]) => {
    if (k === skip) return [];
    const path = `${prefix}.${k}`;
    if (isPlain(v)) return leafPaths(v, path);
    const ident = Array.isArray(v) ? identKey(v, []) : undefined;
    if (Array.isArray(v) && ident) return v.flatMap((item) => leafPaths(item as Record<string, unknown>, `${path}[${String((item as Record<string, unknown>)[ident])}]`, ident));
    return [path];
  });
}

function containsNull(v: unknown): boolean {
  if (v === null) return true;
  if (Array.isArray(v)) return v.some(containsNull);
  if (v && typeof v === 'object') return Object.values(v).some(containsNull);
  return false;
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** RFC 7396, except arrays whose items all have `id` (or all have `key`) merge item-by-item on that identifier. */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (!isPlain(patch)) return structuredClone(patch) as T;
  const out: Record<string, unknown> = isPlain(target) ? { ...target } : {};
  for (const [k, pv] of Object.entries(patch)) {
    const tv = out[k];
    if (Array.isArray(tv) && Array.isArray(pv)) {
      const ident = identKey(tv, pv);
      out[k] = ident ? mergeById(tv, pv, ident) : structuredClone(pv);
    } else {
      out[k] = mergePatch(tv, pv);
    }
  }
  return out as T;
}

function identKey(a: unknown[], b: unknown[]): 'id' | 'key' | undefined {
  const all = [...a, ...b];
  if (all.length === 0) return undefined;
  if (all.every((x) => isPlain(x) && typeof x.id === 'string')) return 'id';
  if (all.every((x) => isPlain(x) && typeof x.key === 'string')) return 'key';
  return undefined;
}

function mergeById(target: unknown[], patch: unknown[], ident: 'id' | 'key'): unknown[] {
  const out = [...target] as Record<string, unknown>[];
  const at = new Map(out.map((x, i) => [x[ident], i]));
  for (const item of patch as Record<string, unknown>[]) {
    const i = at.get(item[ident]);
    if (i !== undefined) out[i] = mergePatch(out[i], item);
    else at.set(item[ident], out.push(structuredClone(item)) - 1);
  }
  return out;
}
