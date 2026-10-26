import { zipSync } from 'fflate';

import type { PackFiles } from '@/engine';
import { fixture, json } from '@/engine/__fixtures__/files';

import type { Character } from '../adapter';
import { installPack, loadPackSet, previewPackZip, uninstallBlockers, uninstallPack } from '../packs';
import { memoryAdapter } from '../__fixtures__/memory';

const zip = (files: PackFiles, top = '') => zipSync(Object.fromEntries([...files].map(([p, b]) => [`${top}${p}`, b])));
const sumAt = (version: string) => fixture('fx-sum', { 'manifest.json': (m: Record<string, unknown>) => ({ ...m, version }) });
const character = (name: string, range: string, expansions: { id: string; range: string }[] = []): Character => ({
  id: name, rev: 0, name, created_at: '', updated_at: '', state: {}, notes: [],
  packs: { major: { id: 'fx-sum', range }, expansions },
});

async function install(adapter: ReturnType<typeof memoryAdapter>, files: PackFiles, top = '') {
  const r = await previewPackZip(adapter, zip(files, top));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  await installPack(adapter, r.preview);
  return r.preview;
}

describe('import preview', () => {
  test('status against installed versions, counts by type label, top folder stripped', async () => {
    const a = memoryAdapter();
    const first = await install(a, sumAt('1.0.0'), 'fx-sum/');
    expect(first.status).toEqual({ kind: 'new' });
    expect(first.counts).toMatchObject({ Calling: 2, Skill: 2, Gear: 2 });
    expect(await a.packs.files('fx-sum', '1.0.0')).toContain('manifest.json');

    const preview = async (v: string) => {
      const r = await previewPackZip(a, zip(sumAt(v)));
      return r.ok ? r.preview : undefined;
    };
    expect((await preview('1.2.0'))?.status).toEqual({ kind: 'upgrade', from: '1.0.0' });
    expect((await preview('1.0.0'))?.status).toEqual({ kind: 'replace' });
    const older = await preview('0.9.0');
    expect(older?.status).toEqual({ kind: 'downgrade', from: '1.0.0' });
    expect(older?.canInstall).toBe(true);
  });

  test('invalid packs return issues and cannot install', async () => {
    const bad = fixture('fx-sum', { 'model/derived.json': (l: unknown[]) => [...l, { id: 'x', formula: '@nope' }] });
    const r = await previewPackZip(memoryAdapter(), zip(bad));
    expect(r.ok && r.preview.canInstall).toBe(false);
    expect(r.ok && r.preview.issues.map((i) => i.message)).toContain('unknown reference @nope');
    expect(await previewPackZip(memoryAdapter(), new Uint8Array([1, 2]))).toMatchObject({ ok: false });
  });

  test('expansions are checked against the newest compatible installed major', async () => {
    const exp = new Map([
      ['manifest.json', json({ id: 'fx-more', name: 'More', kind: 'expansion', version: '1.0.0', schema_version: 1, extends: { id: 'fx-sum', range: '^1.0.0' } })],
      ['content/skill/more.json', json([{ id: 'insight', name: 'Insight', data: { stat: 'grace' } }])],
      ['patches/p.json', json([{ target: 'entity:ghost', merge: { name: 'x' } }])],
    ]);
    const a = memoryAdapter();
    const alone = await previewPackZip(a, zip(exp));
    expect(alone.ok && alone.preview).toMatchObject({ checkedAgainst: null, canInstall: true });
    await install(a, sumAt('1.1.0'));
    const checked = await previewPackZip(a, zip(exp));
    expect(checked.ok && checked.preview).toMatchObject({ checkedAgainst: '1.1.0', canInstall: false });
  });

  test('lists characters whose resolution would change', async () => {
    const a = memoryAdapter();
    await install(a, sumAt('1.0.0'));
    await a.characters.put(character('Ana', '^1.0.0'), null);
    await a.characters.put(character('Bo', '~1.0.0'), null);
    const r = await previewPackZip(a, zip(sumAt('1.3.0')));
    expect(r.ok && r.preview.affected).toEqual(['Ana']);
  });
});

describe('uninstall and pack sets', () => {
  test('uninstall is blocked while a character has no other matching version', async () => {
    const a = memoryAdapter();
    await install(a, sumAt('1.0.0'));
    await install(a, sumAt('2.0.0'));
    await a.characters.put(character('Ana', '^1.0.0'), null);
    expect(await uninstallBlockers(a, 'fx-sum', '1.0.0')).toEqual(['Ana']);
    await expect(uninstallPack(a, 'fx-sum', '1.0.0')).rejects.toThrow('still used by Ana');
    expect(await uninstallBlockers(a, 'fx-sum', '2.0.0')).toEqual([]);
    await uninstallPack(a, 'fx-sum', '2.0.0');
    expect((await a.packs.list()).map((p) => p.version)).toEqual(['1.0.0']);
  });

  test('pack sets resolve pins, report missing packs, and are rebuilt after a replace', async () => {
    const a = memoryAdapter();
    expect(await loadPackSet(a, character('x', '^1.0.0').packs)).toEqual({ ok: false, missing: [{ id: 'fx-sum', range: '^1.0.0' }], issues: [] });
    await install(a, sumAt('1.0.0'));
    const first = await loadPackSet(a, character('x', '^1.0.0').packs);
    expect(first.ok && first.key).toBe('fx-sum@1.0.0');
    const again = await loadPackSet(a, character('x', '^1.0.0').packs);
    expect(again.ok && first.ok && again.compiled === first.compiled).toBe(true);
    // same version re-imported with a fix: the cached set must not be reused
    await install(a, fixture('fx-sum', { 'content/lineage/all.json': (l: { id: string; name: string }[]) => l.map((x) => ({ ...x, name: `${x.name}!` })) }));
    const replaced = await loadPackSet(a, character('x', '^1.0.0').packs);
    expect(replaced.ok && replaced.compiled.entities.get('stout')!.envelope.name).toBe('Stout!');
  });
});

test('memory adapter enforces rev like the real one', async () => {
  const a = memoryAdapter();
  const saved = await a.characters.put(character('Ana', '^1'), null);
  expect(saved.rev).toBe(1);
  await expect(a.characters.put(saved, 0)).rejects.toThrow();
  expect((await a.characters.put(saved, 1)).rev).toBe(2);
});
