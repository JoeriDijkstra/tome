// Zip/folder → RawPack: safety limits, fixed layout, JSON + zod per file. See docs/SPEC.md → Layout.
import { strFromU8, unzipSync } from 'fflate';
import type { z } from 'zod';

import * as S from './schema';

export const LIMITS = {
  zipBytes: 100 * 1024 * 1024,
  /** sum of declared sizes of everything extracted: what unzipping may allocate */
  unzippedBytes: 256 * 1024 * 1024,
  entries: 20_000,
  jsonBytes: 2 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  jsonDepth: 64,
};

export interface Issue {
  level: 'error' | 'warning';
  /** `<pack>:<file>#<json pointer>` */
  at: string;
  message: string;
}

export interface Located<T> {
  v: T;
  /** `<pack>:<file>#/<index>` — where the item came from, for error messages */
  at: string;
}

export type LocatedEntity = Located<S.Entity & { type: string }>;

export interface RawPack {
  manifest: S.Manifest;
  character?: Located<z.infer<typeof S.Character>>;
  sheet?: Located<z.infer<typeof S.Sheet>>;
  creation?: Located<z.infer<typeof S.Creation>>;
  entityTypes: Located<S.EntityType>[];
  derived: Located<S.Derived>[];
  resources: Located<S.ResourceDef>[];
  modifierTypes: Located<z.infer<typeof S.ModifierType>>[];
  constraints: Located<S.Constraint>[];
  tables: Located<z.infer<typeof S.TableDef>>[];
  entities: LocatedEntity[];
  tabs: Located<z.infer<typeof S.Tab>>[];
  actions: Located<S.Action>[];
  modals: Located<S.Modal>[];
  patches: Located<S.Patch>[];
  assets: string[];
  license?: string;
}

export type PackFiles = Map<string, Uint8Array>;

const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$)/;
const ALLOWED_EXT = /\.(json|md|png|jpe?g|webp)$/i;

/**
 * Unzip with zip-bomb guards. fflate allocates each entry from the sizes the zip declares, so those are
 * bounded per entry and in total before anything is inflated. Directory entries and macOS junk are dropped.
 */
export function unzip(bytes: Uint8Array): { files?: PackFiles; issues: Issue[] } {
  if (bytes.length > LIMITS.zipBytes) return fail('zip', `zip is larger than ${LIMITS.zipBytes / 1024 / 1024} MB`);
  let entries = 0;
  let total = 0;
  let problem: { at: string; message: string } | undefined;
  try {
    const out = unzipSync(bytes, {
      filter(f) {
        if (problem || f.name.endsWith('/') || IGNORED.test(f.name)) return false;
        const declared = Math.max(f.size, f.originalSize);
        const limit = f.name.endsWith('.json') ? LIMITS.jsonBytes : LIMITS.fileBytes;
        total += declared;
        if (++entries > LIMITS.entries) problem = { at: 'zip', message: `more than ${LIMITS.entries} files` };
        else if (f.compression !== 0 && f.compression !== 8) problem = { at: f.name, message: 'unsupported zip compression' };
        else if (declared > limit) problem = { at: f.name, message: `file is larger than ${limit / 1024 / 1024} MB` };
        else if (total > LIMITS.unzippedBytes) problem = { at: 'zip', message: `pack is larger than ${LIMITS.unzippedBytes / 1024 / 1024} MB unzipped` };
        return !problem;
      },
    });
    if (problem) return fail(problem.at, problem.message);
    return { files: new Map(Object.entries(out)), issues: [] };
  } catch (e) {
    return fail('zip', `not a valid zip: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function fail(at: string, message: string): { issues: Issue[] } {
  return { issues: [{ level: 'error', at, message }] };
}

const SINGLETONS = { 'model/character.json': 'character', 'ui/sheet.json': 'sheet', 'ui/creation.json': 'creation' } as const;
const COLLECTIONS: [RegExp, keyof RawPack, z.ZodType][] = [
  [/^model\/entity-types\.json$/, 'entityTypes', S.EntityType],
  [/^model\/derived\.json$/, 'derived', S.Derived],
  [/^model\/resources\.json$/, 'resources', S.ResourceDef],
  [/^model\/modifier-types\.json$/, 'modifierTypes', S.ModifierType],
  [/^model\/constraints\.json$/, 'constraints', S.Constraint],
  [/^model\/tables\/[^/]+\.json$/, 'tables', S.TableDef],
  [/^content\/[^/]+\/[^/]+\.json$/, 'entities', S.Entity],
  [/^ui\/tabs\/[^/]+\.json$/, 'tabs', S.Tab],
  [/^ui\/actions\/[^/]+\.json$/, 'actions', S.Action],
  [/^ui\/modals\/[^/]+\.json$/, 'modals', S.Modal],
  [/^patches\/[^/]+\.json$/, 'patches', S.Patch],
];
const SINGLETON_SCHEMAS = { character: S.Character, sheet: S.Sheet, creation: S.Creation };
/** Schema per pack part, for re-checking items after a patch merges into them. */
export const PART_SCHEMAS: Record<string, z.ZodType> = {
  ...Object.fromEntries(COLLECTIONS.map(([, key, schema]) => [key, schema])),
  ...SINGLETON_SCHEMAS,
};

/** Parse a pack's files (paths relative to the pack root, or inside one top-level folder). */
export function loadPack(input: PackFiles): { pack?: RawPack; issues: Issue[] } {
  const files = stripTopFolder(input);
  const issues: Issue[] = [];
  const err = (at: string, message: string) => issues.push({ level: 'error', at, message });

  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) return fail('manifest.json', 'manifest.json is missing');
  const manifestJson = json(manifestBytes, 'manifest.json', err);
  if (manifestJson === undefined) return { issues };
  if (typeof manifestJson === 'object' && manifestJson && 'schema_version' in manifestJson) {
    const sv = manifestJson.schema_version;
    if (typeof sv === 'number' && sv > Math.max(...S.SUPPORTED_SCHEMA_VERSIONS)) {
      return fail('manifest.json#/schema_version', `this pack needs a newer Tome (schema_version ${sv}); update Tome to use this pack`);
    }
    if (typeof sv === 'number' && !S.SUPPORTED_SCHEMA_VERSIONS.includes(sv)) {
      return fail('manifest.json#/schema_version', `schema_version ${sv} is not supported`);
    }
  }
  const manifest = S.Manifest.safeParse(manifestJson);
  if (!manifest.success) {
    zodIssues(manifest.error, 'manifest.json', '', err);
    return { issues };
  }
  const id = manifest.data.id;
  const at = (file: string, pointer = '') => `${id}:${file}${pointer ? `#${pointer}` : ''}`;

  const pack: RawPack = {
    manifest: manifest.data,
    entityTypes: [], derived: [], resources: [], modifierTypes: [], constraints: [], tables: [],
    entities: [], tabs: [], actions: [], modals: [], patches: [], assets: [],
  };

  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (path === 'manifest.json') continue;
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) { err(path, 'unsafe path'); continue; }
    if (!ALLOWED_EXT.test(path)) { err(at(path), 'file type not allowed in a pack'); continue; }
    if (path === 'LICENSE.md') { pack.license = strFromU8(bytes); continue; }
    if (/^assets\//.test(path)) {
      if (/^assets\/[A-Za-z0-9_\-./]+\.(png|jpe?g|webp)$/i.test(path)) pack.assets.push(path);
      else err(at(path), 'asset names may only use letters, digits, - _ . and /');
      continue;
    }
    if (!path.endsWith('.json')) { err(at(path), 'file is not in a known pack folder'); continue; }
    if (bytes.length > LIMITS.jsonBytes) { err(at(path), `JSON file is larger than ${LIMITS.jsonBytes / 1024 / 1024} MB`); continue; }

    const singleton = SINGLETONS[path as keyof typeof SINGLETONS];
    if (singleton) {
      const value = json(bytes, at(path), err);
      if (value === undefined) continue;
      const parsed = SINGLETON_SCHEMAS[singleton].safeParse(value);
      if (!parsed.success) { zodIssues(parsed.error, at(path), '', err); continue; }
      Object.assign(pack, { [singleton]: { v: parsed.data, at: at(path) } });
      continue;
    }
    const collection = COLLECTIONS.find(([re]) => re.test(path));
    if (!collection) { err(at(path), 'file is not in a known pack folder'); continue; }
    const [, key, schema] = collection;
    const value = json(bytes, at(path), err);
    if (value === undefined) continue;
    if (!Array.isArray(value)) { err(at(path), 'collection files must be a JSON array'); continue; }
    const list = pack[key] as Located<unknown>[];
    const type = key === 'entities' ? path.split('/')[1] : undefined;
    value.forEach((item, i) => {
      const parsed = schema.safeParse(item);
      if (!parsed.success) { zodIssues(parsed.error, at(path), `/${i}`, err); return; }
      const v = type ? { ...(parsed.data as object), type } : parsed.data;
      list.push({ v, at: at(path, `/${i}`) });
    });
  }
  return { pack: issues.some((i) => i.level === 'error') ? undefined : pack, issues };
}

/** Pack files zipped inside one top-level folder, re-rooted so `manifest.json` is at the top. */
export function stripTopFolder(files: PackFiles): PackFiles {
  if (files.has('manifest.json')) return files;
  const tops = new Set([...files.keys()].map((p) => p.split('/')[0]));
  if (tops.size !== 1) return files;
  const [top] = tops;
  return new Map([...files].map(([p, b]) => [p.slice(top.length + 1), b]));
}

function json(bytes: Uint8Array, at: string, err: (at: string, m: string) => void): unknown {
  const text = strFromU8(bytes);
  if (nesting(text) > LIMITS.jsonDepth) {
    err(at, `JSON is nested deeper than ${LIMITS.jsonDepth} levels`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    err(at, `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Deepest [ / { nesting, ignoring brackets inside strings. Bounds every recursive pass over pack JSON. */
function nesting(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') max = Math.max(max, ++depth);
    else if (c === ']' || c === '}') depth--;
  }
  return max;
}

function zodIssues(error: z.ZodError, at: string, prefix: string, err: (at: string, m: string) => void) {
  for (const issue of error.issues) err(`${at}#${prefix}${issue.path.map((p) => `/${String(p)}`).join('')}`, issue.message);
}
