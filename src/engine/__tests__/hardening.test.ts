// Regressions from the M1 review: untrusted packs and answers must not crash, hang or corrupt state.
import { zipSync } from 'fflate';

import type { Compiled } from '../compile';
import { runAction, runBatch, runCreation } from '../effects';
import { createView } from '../evaluate';
import { buildPackSet } from '../index';
import { unzip } from '../load';
import { fixture, json } from '../__fixtures__/files';

type Json = Record<string, unknown>;
type JsonList = Json[];
const errors = (files: Map<string, Uint8Array>, expansions: Map<string, Uint8Array>[] = []) =>
  buildPackSet(files, expansions).issues.filter((i) => i.level === 'error').map((i) => i.message);
const compiled = (files: Map<string, Uint8Array>): Compiled => {
  const r = buildPackSet(files);
  expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
  return r.compiled!;
};
const sum = compiled(fixture('fx-sum'));
const hero = { lineage: 'stout', callings: { warrior: { level: 1 } }, stats: { might: 15, grace: 13, vigor: 14 } };

test('unzip rejects entries by their declared size before inflating them', () => {
  const zip = zipSync({ 'manifest.json': json({}), 'model/derived.json': new Uint8Array(3 * 1024 * 1024).fill(32) });
  expect(unzip(zip).issues[0]).toMatchObject({ at: 'model/derived.json', message: 'file is larger than 2 MB' });
});

test('expensive and self-referencing formulas evaluate to null with a warning instead of hanging or overflowing', () => {
  const nested = Array.from({ length: 7 }).reduce<string>((inner) => `sum([0,1,2,3,4,5,6,7,8,9], ${inner})`, '1');
  const c = compiled(fixture('fx-typed', {
    'model/derived.json': (l: JsonList) => [...l, { id: 'slow', formula: nested }, { id: 'loop', formula: "entity('long_jump').data.prereq" }],
    'content/feat/all.json': (l: JsonList) => l.map((f) => (f.id === 'long_jump' ? { ...f, data: { level: 2, prereq: "entity('long_jump').data.prereq" } } : f)),
  }));
  const v = createView(c, {});
  expect(v.root('slow')).toBeNull();
  expect(v.root('loop')).toBeNull();
  expect([...v.warnings].join('\n')).toMatch(/too expensive[\s\S]*nest too deeply/);
});

test('patches are re-validated and cannot change ids or types', () => {
  const exp = (merge: Json) => new Map([
    ['manifest.json', json({ id: 'fx-bad', name: 'x', kind: 'expansion', version: '1.0.0', schema_version: 1, extends: { id: 'fx-sum', range: '^1' } })],
    ['patches/p.json', json([{ target: 'entity:warrior', merge }])],
  ]);
  expect(errors(fixture('fx-sum'), [exp({ modifiers: 'oops' })])).toEqual([expect.stringMatching(/after patching entity:warrior: modifiers/)]);
  expect(errors(fixture('fx-sum'), [exp({ features: [{ id: 'nameless' }] })])).toEqual([expect.stringMatching(/features\.2\.name/)]);
  expect(errors(fixture('fx-sum'), [exp({ id: 'renamed' })])).toEqual(["patches cannot change an item's id or type"]);
});

test('ownership may not read @features, @owned or @res', () => {
  for (const when of ["has(map(@features, $v.id), 'second_breath')", 'count(@owned) > 0', '@res.hp.current > 0']) {
    const files = fixture('fx-sum', { 'content/lineage/all.json': (l: JsonList) => l.map((x) => (x.id === 'stout' ? { ...x, grants: [{ entity: 'darksight', when }] } : x)) });
    expect(errors(files)).toEqual([expect.stringMatching(/ownership can't read/)]);
  }
});

test('resource writes must name a resource value', () => {
  const files = fixture('fx-sum', { 'ui/actions/all.json': (l: JsonList) => [...l, { id: 'wipe', label: 'x', effects: [{ op: 'set', path: 'res', value: 7 }] }] });
  expect(errors(files)).toEqual(['resource writes must be res.<id>.current or res.<id>.temp']);
});

test('add on a resource starts from the clamped value the sheet shows', async () => {
  const over = { ...hero, res: { hp: { current: 30 } } };
  const r = await runAction(sum, over, 'take_damage', { answers: [{ amount: 5 }] });
  expect(r.ok && createView(sum, r.state).eval('@res.hp.current')).toBe(8);
});

test('writes are validated all the way down', async () => {
  const set = (path: string, value: string) => runBatch(sum, hero, [{ op: 'set', path, value }]);
  expect(await set('stats', "{might: 99, grace: 'x', vigor: 14}")).toMatchObject({ ok: false, rejected: expect.stringMatching(/stats\.grace: expected a number/) });
  const ok = await set('stats', '{might: 99, grace: 12, vigor: 14}');
  expect(ok.ok && ok.state.stats).toEqual({ might: 30, grace: 12, vigor: 14 });
  expect(await runBatch(sum, hero, [{ op: 'push', path: 'paths', value: "'nope'" }])).toMatchObject({ ok: false });
  expect(await set("callings['seer']", '{level: 1}')).toMatchObject({ ok: false, rejected: expect.stringMatching(/not a calling/) });
});

test('answers are held to the inputs they answer', async () => {
  expect(await runAction(sum, hero, 'level_up', { answers: [{ calling: ['champion'] }] })).toMatchObject({ ok: false, rejected: expect.stringMatching(/not offered/) });
  const l2 = { ...hero, callings: { warrior: { level: 2 } } };
  expect(await runAction(sum, l2, 'level_up', { answers: [{ calling: ['warrior'] }, ['champion', 'champion']] })).toMatchObject({ ok: false });
});

test('a choice with nothing to offer asks nothing', async () => {
  const c = compiled(fixture('fx-sum', { 'content/path/all.json': () => [] }));
  const r = await runAction(c, { ...hero, callings: { warrior: { level: 2 } } }, 'level_up', { answers: [{ calling: ['warrior'] }] });
  expect(r.ok && r.state.paths).toEqual([]);
});

test('creation must satisfy every constraint', async () => {
  const c = compiled(fixture('fx-sum', { 'model/constraints.json': (l: JsonList) => [...l, { id: 'pick_lineage', violated_when: '@lineage == null', message: 'Pick a lineage.' }] }));
  expect(await runCreation(c, { calling: { calling: ['warrior'] }, stats: { stats: { might: 10, grace: 10, vigor: 10 } } }))
    .toEqual({ ok: false, rejected: 'Pick a lineage.' });
});
