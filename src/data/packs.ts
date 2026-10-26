// Pack lifecycle on top of a DataAdapter: import preview, install, guarded uninstall, compiled pack sets.
// See docs/SPEC.md → Pack import dialog, Resolution.
import semver from 'semver';

import {
  buildPackSet,
  type CharacterPins,
  type Compiled,
  type Installed,
  type Issue,
  loadPack,
  type Manifest,
  type PackFiles,
  type Pin,
  resolutionKey,
  resolvePins,
  stripTopFolder,
  unzip,
} from '@/engine';

import type { CharacterSummary, DataAdapter, InstalledPack } from './adapter';

/** The newest installed version of each pack. */
export function newestVersions(packs: InstalledPack[]): InstalledPack[] {
  const out = new Map<string, InstalledPack>();
  for (const p of packs) if (!out.has(p.id) || semver.gt(p.version, out.get(p.id)!.version)) out.set(p.id, p);
  return [...out.values()];
}

export type InstallStatus =
  | { kind: 'new' }
  | { kind: 'upgrade'; from: string }
  | { kind: 'replace' }
  | { kind: 'downgrade'; from: string };

export interface PackPreview {
  manifest: Manifest;
  files: PackFiles;
  issues: Issue[];
  status: InstallStatus;
  /** expansions: the installed major version it was checked against, or null when none fits */
  checkedAgainst?: string | null;
  /** entity type label → how many this pack adds */
  counts: Record<string, number>;
  license?: string;
  /** characters whose pack resolution changes when this is installed */
  affected: string[];
  canInstall: boolean;
}

export type ImportResult = { ok: true; preview: PackPreview } | { ok: false; issues: Issue[] };

const installedOf = (list: { id: string; version: string }[]): Installed[] => list.map(({ id, version }) => ({ id, version }));

export async function readPack(adapter: DataAdapter, id: string, version: string): Promise<PackFiles> {
  const paths = await adapter.packs.files(id, version);
  return new Map(await Promise.all(paths.map(async (p): Promise<[string, Uint8Array]> => [p, await adapter.packs.readFile(id, version, p)])));
}

/** Everything the import dialog shows, from the picked zip's bytes. Nothing is written. */
export async function previewPackZip(adapter: DataAdapter, zip: Uint8Array): Promise<ImportResult> {
  const unzipped = unzip(zip);
  if (!unzipped.files) return { ok: false, issues: unzipped.issues };
  // stored with the top folder stripped, the same layout the engine validates
  const files = stripTopFolder(unzipped.files);
  const loaded = loadPack(files);
  if (!loaded.pack) return { ok: false, issues: loaded.issues };
  const { manifest } = loaded.pack;

  const installed = await adapter.packs.list();
  let issues: Issue[];
  let checkedAgainst: string | null | undefined;
  let typeLabels: Map<string, string> | undefined;
  if (manifest.kind === 'major') {
    const built = buildPackSet(files);
    issues = built.issues;
    typeLabels = built.compiled && new Map([...built.compiled.entityTypes].map(([id, t]) => [id, t.plural ?? t.label]));
  } else {
    const range = manifest.extends!.range;
    const majorVersion = semver.maxSatisfying(installed.filter((p) => p.id === manifest.extends!.id).map((p) => p.version), range);
    checkedAgainst = majorVersion;
    if (majorVersion) {
      const built = buildPackSet(await readPack(adapter, manifest.extends!.id, majorVersion), [files]);
      issues = built.issues;
      typeLabels = built.compiled && new Map([...built.compiled.entityTypes].map(([id, t]) => [id, t.plural ?? t.label]));
    } else {
      issues = [...loaded.issues, { level: 'warning', at: `${manifest.id}:manifest.json#/extends`, message: `needs ${manifest.extends!.id} ${range}, which isn't installed; it can't be used until it is` }];
    }
  }

  const counts: Record<string, number> = {};
  for (const e of loaded.pack.entities) {
    const label = typeLabels?.get(e.v.type) ?? e.v.type;
    counts[label] = (counts[label] ?? 0) + 1;
  }

  const sameId = installed.filter((p) => p.id === manifest.id).map((p) => p.version);
  const newest = semver.maxSatisfying(sameId, '*');
  const status: InstallStatus = sameId.includes(manifest.version)
    ? { kind: 'replace' }
    : !newest ? { kind: 'new' }
    : semver.gt(manifest.version, newest) ? { kind: 'upgrade', from: newest }
    : { kind: 'downgrade', from: newest };
  if (status.kind === 'downgrade') issues = [...issues, { level: 'warning', at: `${manifest.id}:manifest.json#/version`, message: `${newest} is already installed; this adds the older ${manifest.version} next to it` }];

  const after = [...installedOf(installed), { id: manifest.id, version: manifest.version }];
  const affected = changedResolutions(await adapter.characters.list(), installedOf(installed), after, manifest.id);

  return {
    ok: true,
    preview: {
      manifest, files, issues, status, checkedAgainst, counts, affected,
      license: loaded.pack.license,
      canInstall: !issues.some((i) => i.level === 'error'),
    },
  };
}

/** Names of characters whose resolved version of `packId` differs between two installed sets. */
function changedResolutions(characters: CharacterSummary[], before: Installed[], after: Installed[], packId: string): string[] {
  const versionOf = (pins: CharacterPins, installed: Installed[]) => resolvePins(pins, installed).resolved.find((r) => r.id === packId)?.version;
  return characters
    .filter((c) => [c.packs.major, ...c.packs.expansions].some((p) => p.id === packId))
    .filter((c) => versionOf(c.packs, before) !== versionOf(c.packs, after))
    .map((c) => c.name);
}

export async function installPack(adapter: DataAdapter, preview: PackPreview): Promise<void> {
  if (!preview.canInstall) throw new Error('this pack has errors and cannot be installed');
  await adapter.packs.install(preview.manifest, preview.files);
  forget(preview.manifest.id, preview.manifest.version);
}

/** Characters that would be left without any installed version matching their pin. */
export async function uninstallBlockers(adapter: DataAdapter, id: string, version: string): Promise<string[]> {
  const installed = installedOf(await adapter.packs.list());
  const after = installed.filter((p) => !(p.id === id && p.version === version));
  return (await adapter.characters.list())
    .filter((c) => resolvePins(c.packs, installed).missing.every((m) => m.id !== id))
    .filter((c) => resolvePins(c.packs, after).missing.some((m) => m.id === id))
    .map((c) => c.name);
}

export async function uninstallPack(adapter: DataAdapter, id: string, version: string): Promise<void> {
  const blockers = await uninstallBlockers(adapter, id, version);
  if (blockers.length) throw new Error(`still used by ${blockers.join(', ')}`);
  await adapter.packs.uninstall(id, version);
  forget(id, version);
}

// ----- compiled pack sets, cached by resolution key -----

const cache = new Map<string, Compiled>();

/** Drop cached sets that include a pack version that was just replaced or removed. */
function forget(id: string, version: string) {
  for (const key of cache.keys()) if (key.split('+').includes(`${id}@${version}`)) cache.delete(key);
}

export type PackSetResult = { ok: true; compiled: Compiled; key: string } | { ok: false; missing: Pin[]; issues: Issue[] };

export async function loadPackSet(adapter: DataAdapter, pins: CharacterPins): Promise<PackSetResult> {
  const { resolved, missing } = resolvePins(pins, installedOf(await adapter.packs.list()));
  if (missing.length) return { ok: false, missing, issues: [] };
  const key = resolutionKey(resolved);
  const hit = cache.get(key);
  if (hit) return { ok: true, compiled: hit, key };
  const [major, ...expansions] = await Promise.all(resolved.map((p) => readPack(adapter, p.id, p.version)));
  const built = buildPackSet(major, expansions);
  if (!built.compiled) return { ok: false, missing: [], issues: built.issues };
  cache.set(key, built.compiled);
  return { ok: true, compiled: built.compiled, key };
}
