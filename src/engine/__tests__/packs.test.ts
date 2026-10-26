import { zipSync } from 'fflate';

import { createView } from '../evaluate';
import { buildPackSet } from '../index';
import { loadPack, unzip, type PackFiles } from '../load';
import { mergePatch, resolvePins } from '../merge';
import { fixture, json } from '../__fixtures__/files';

const errors = (files: PackFiles, expansions: PackFiles[] = []) =>
  buildPackSet(files, expansions).issues.filter((i) => i.level === 'error').map((i) => `${i.at}: ${i.message}`);

type Json = Record<string, unknown>;
type JsonList = Json[];

describe('loading', () => {
  test('a newer schema_version asks for a Tome update', () => {
    const files = fixture('fx-sum', { 'manifest.json': (m: Json) => ({ ...m, schema_version: 2 }) });
    expect(loadPack(files).issues[0].message).toMatch(/update Tome/);
  });

  test('layout: unknown folders, file types and unsafe paths are rejected', () => {
    const files = fixture('fx-sum');
    files.set('scripts/run.js', json(1));
    files.set('notes.txt', json(1));
    files.set('model/extra.json', json([]));
    files.set('content/../x.json', json([]));
    expect(loadPack(files).issues.map((i) => i.message).sort()).toEqual([
      'file is not in a known pack folder',
      'file type not allowed in a pack',
      'file type not allowed in a pack',
      'unsafe path',
    ]);
  });

  test('id grammar is enforced with a file + pointer location', () => {
    const files = fixture('fx-sum', { 'content/skill/all.json': (l: JsonList) => [...l, { id: 'sleight-of-hand', name: 'x' }] });
    expect(loadPack(files).issues).toEqual([expect.objectContaining({ at: 'fx-sum:content/skill/all.json#/2/id' })]);
  });

  test('zips: a single top folder is stripped, macOS junk ignored', () => {
    const entries = Object.fromEntries([...fixture('fx-sum')].map(([p, b]) => [`fx-sum/${p}`, b]));
    const zip = zipSync({ ...entries, '__MACOSX/fx-sum/._manifest.json': new Uint8Array([0]), 'fx-sum/.DS_Store': new Uint8Array([0]) });
    const { files } = unzip(zip);
    expect(buildPackSet(files!).compiled).toBeDefined();
    expect(unzip(new Uint8Array([1, 2, 3])).issues[0].message).toMatch(/not a valid zip/);
  });
});

describe('compile checks', () => {
  test('unknown references, tables, entities and undeclared content types', () => {
    const files = fixture('fx-sum', {
      'model/derived.json': (l: JsonList) => [...l, { id: 'oops', formula: "@nothing + lookup('nope', 1, 'x')" }],
      'content/lineage/all.json': (l: JsonList) => [...l, { id: 'ghost', name: 'Ghost', grants: [{ entity: 'missing' }] }],
    });
    files.set('content/vehicle/all.json', json([{ id: 'cart', name: 'Cart' }]));
    expect(errors(files)).toEqual(expect.arrayContaining([
      expect.stringMatching(/unknown reference @nothing/),
      expect.stringMatching(/unknown table 'nope'/),
      expect.stringMatching(/unknown entity 'missing'/),
      expect.stringMatching(/content\/vehicle\/ is not a declared entity type/),
    ]));
  });

  test('dependency cycles through derived values and modifiers', () => {
    const files = fixture('fx-sum', {
      'model/derived.json': (l: JsonList) => [...l, { id: 'a', formula: '@b' }, { id: 'b', formula: '@a + @defense' }],
      'content/gear/all.json': (l: JsonList) => [...l, { id: 'mirror', name: 'Mirror', data: { kind: 'trinket' }, modifiers: [{ target: 'defense', op: 'add', value: '@defense' }] }],
    });
    const errs = errors(files);
    expect(errs).toEqual(expect.arrayContaining([expect.stringMatching(/dependency cycle: a → b → a/), expect.stringMatching(/dependency cycle: defense → defense/)]));
  });

  test('ownership may not read values that modifiers change', () => {
    const bad = fixture('fx-sum', { 'model/character.json': (c: { fields: Json[] }) => ({
      fields: c.fields.map((f) => (f.key === 'gear' ? { ...f, owns_when: '$v.equipped && @stats.vigor > 10' } : f)),
    }) });
    expect(errors(bad)).toEqual([expect.stringMatching(/ownership can't depend on values modifiers change \(@stats\)/)]);
    const fine = fixture('fx-sum', { 'model/character.json': (c: { fields: Json[] }) => ({
      fields: c.fields.map((f) => (f.key === 'gear' ? { ...f, owns_when: '$v.equipped && @base.stats.vigor > 10 && @level >= 1' } : f)),
    }) });
    expect(errors(fine)).toEqual([]);
  });

  test('grant cycles', () => {
    const files = fixture('fx-sum', { 'content/perk/all.json': () => [
      { id: 'darksight', name: 'Darksight', grants: [{ entity: 'keen' }] },
      { id: 'keen', name: 'Keen', grants: [{ entity: 'darksight' }] },
    ] });
    expect(errors(files)).toEqual(expect.arrayContaining([expect.stringMatching(/grant cycle: darksight → keen → darksight/)]));
  });

  test('ui/: text fields are templates, formula fields are formulas, references must exist', () => {
    const files = fixture('fx-sum', {
      'ui/sheet.json': (s: Json) => ({ ...s, header: { title: 'Level {@nope}', subtitle: 'Plain @name stays text', actions: ['long_rest', 'ghost'] } }),
      'ui/tabs/main.json': () => [{ id: 'main', label: 'Main', sections: [
        { widget: 'stat', label: 'Defense', value: '@defense +', explain: 'nowhere' },
        { widget: 'resource', resource: 'mana' },
        { widget: 'list', source: '@features', row: { title: '{$v.name' } },
      ] }],
    });
    expect(errors(files).map((e) => e.replace(/^fx-sum:ui\//, ''))).toEqual([
      expect.stringMatching(/^tabs\/main\.json#\/0\/sections\/0\/value: formula: unexpected end/),
      expect.stringMatching(/^tabs\/main\.json#\/0\/sections\/0\/explain: modifier target 'nowhere'/),
      "tabs/main.json#/0/sections/1/resource: unknown resource 'mana'",
      expect.stringMatching(/^tabs\/main\.json#\/0\/sections\/2\/row\/title: text: unclosed/),
      'sheet.json#/header/title: unknown reference @nope',
      "sheet.json#/header/actions/1: unknown action 'ghost'",
    ]);
    const toggles = fixture('fx-sum', { 'ui/tabs/main.json': () => [{ id: 'main', label: 'Main', sections: [{ widget: 'toggles', path: 'paths' }] }] });
    expect(errors(toggles)).toEqual([expect.stringMatching(/toggles need either "items", or "path" \+ "options" \+ "label"/)]);
  });

  test('a stat can open an unlisted tab as a page; an unknown page is an error', () => {
    const page = (open: string) => fixture('fx-sum', { 'ui/tabs/main.json': (l: JsonList) => [
      { ...l[0], sections: [...(l[0].sections as JsonList), { widget: 'stat', label: 'More', value: '1', open }] },
      { id: 'more', label: 'More', sections: [] },
    ] });
    const ok = buildPackSet(page('more'));
    expect(ok.issues).toEqual([]);
    expect(ok.compiled?.tabs.map((t) => t.id)).not.toContain('more');
    expect(ok.compiled?.pages.get('more')?.label).toBe('More');
    expect(errors(page('gone'))).toEqual([expect.stringMatching(/unknown tab 'gone'/)]);
  });

  test('effects may only write stored fields and res', () => {
    const files = fixture('fx-sum', { 'ui/actions/all.json': (l: JsonList) => [...l, { id: 'cheat', label: 'x', effects: [{ op: 'set', path: 'defense', value: 30 }] }] });
    expect(errors(files)).toEqual([expect.stringMatching(/cannot write to 'defense'/)]);
  });
});

describe('expansions', () => {
  const expansion = (id: string, extra: [string, unknown][] = []): PackFiles => new Map([
    ['manifest.json', json({ id, name: id, kind: 'expansion', version: '1.0.0', schema_version: 1, extends: { id: 'fx-sum', range: '^1.0.0' } })],
    ...extra.map(([p, v]): [string, Uint8Array] => [p, json(v)]),
  ]);

  test('adds content and patches arrays by id, keeping untouched items', () => {
    const exp = expansion('fx-errata', [
      ['content/lineage/extra.json', [{ id: 'tall', name: 'Tall' }]],
      ['patches/warrior.json', [{ target: 'entity:warrior', merge: { features: [{ id: 'second_breath', name: 'Second Wind' }] } }]],
    ]);
    const { compiled, issues } = buildPackSet(fixture('fx-sum'), [exp]);
    expect(issues).toEqual([]);
    const warrior = compiled!.entities.get('warrior')!;
    expect(warrior.features.map((f) => [f.id, f.name])).toEqual([['second_breath', 'Second Wind'], ['guard_style', 'Guard Style']]);
    expect(compiled!.entities.has('tall')).toBe(true);
    expect(createView(compiled!, { callings: { warrior: { level: 1 } } }).features()[0].name).toBe('Second Wind');
  });

  test('id collisions, deletes and replaced singletons are errors; overlapping patches warn', () => {
    expect(errors(fixture('fx-sum'), [expansion('fx-a', [['content/lineage/x.json', [{ id: 'stout', name: 'Dup' }]]])]))
      .toEqual([expect.stringMatching(/id 'stout' already exists/)]);
    expect(errors(fixture('fx-sum'), [expansion('fx-a', [['patches/x.json', [{ target: 'entity:stout', merge: { summary: null } }]]])]))
      .toEqual([expect.stringMatching(/patches cannot delete/)]);
    expect(errors(fixture('fx-sum'), [expansion('fx-a', [['ui/sheet.json', { tabs: [] }]])]))
      .toEqual([expect.stringMatching(/change sheet through patches/)]);
    const patch = (name: string): [string, unknown] => ['patches/p.json', [{ target: 'entity:stout', merge: { name } }]];
    const { issues, compiled } = buildPackSet(fixture('fx-sum'), [expansion('fx-a', [patch('A')]), expansion('fx-b', [patch('B')])]);
    expect(issues).toEqual([expect.objectContaining({ level: 'warning', message: 'fx-b and fx-a both patch entity:stout.name; fx-b wins' })]);
    expect(compiled!.entities.get('stout')!.envelope.name).toBe('B');
  });

  test('mergePatch: objects merge, plain arrays replace, keyed arrays merge by key', () => {
    expect(mergePatch({ a: 1, b: { c: 2 }, l: [1, 2] }, { b: { d: 3 }, l: [9] })).toEqual({ a: 1, b: { c: 2, d: 3 }, l: [9] });
    expect(mergePatch({ fields: [{ key: 'x', default: 1 }, { key: 'y' }] }, { fields: [{ key: 'x', default: 2 }, { key: 'z' }] }))
      .toEqual({ fields: [{ key: 'x', default: 2 }, { key: 'y' }, { key: 'z' }] });
  });
});

test('resolvePins picks the newest installed version in range', () => {
  const installed = [{ id: 'd', version: '1.0.0' }, { id: 'd', version: '1.4.2' }, { id: 'd', version: '2.0.0' }, { id: 'x', version: '0.1.0' }];
  expect(resolvePins({ major: { id: 'd', range: '^1.0.0' }, expansions: [{ id: 'x', range: '^1.0.0' }] }, installed)).toEqual({
    resolved: [{ id: 'd', version: '1.4.2' }],
    missing: [{ id: 'x', range: '^1.0.0' }],
  });
});
