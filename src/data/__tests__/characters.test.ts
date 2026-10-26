import type { Character } from '../adapter';
import { characterFile, importCharacterFile } from '../characters';
import { memoryAdapter } from '../__fixtures__/memory';

const arya: Character = {
  id: 'arya', rev: 4, name: 'Arya', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  packs: { major: { id: 'fx-sum', range: '^1.1.0' }, expansions: [] },
  state: { stats: { might: 15 }, perks: ['keen_eye'] },
  notes: [{ id: 'n1', title: 'Session 1', body: '**Met** the mayor.', updated_at: '2026-01-02T00:00:00.000Z' }],
};

test('a character file comes back as a new character with the same sheet and notes', async () => {
  const a = memoryAdapter();
  const r = await importCharacterFile(a, characterFile(arya, [{ id: 'fx-sum', version: '1.2.0' }]));
  if (!r.ok) throw new Error(r.error);
  // importing twice on the same device must not overwrite the original
  expect(r.doc.id).not.toBe('arya');
  expect(r.doc).toMatchObject({ rev: 1, name: 'Arya', created_at: arya.created_at, packs: arya.packs, state: arya.state, notes: arya.notes });
  expect(await a.characters.get(r.doc.id)).toEqual(r.doc);
});

test('files that are not Tome characters are rejected with a reason, and nothing is stored', async () => {
  const a = memoryAdapter();
  const file = JSON.parse(characterFile(arya, []));
  const bad = [
    'not json',
    JSON.stringify({ ...file, format: 'other.app' }),
    JSON.stringify({ ...file, format_version: 2 }),
    JSON.stringify({ ...file, character: { ...file.character, name: '  ' } }),
    JSON.stringify({ ...file, character: { ...file.character, packs: { major: { id: 'fx-sum', range: 'latest-ish' }, expansions: [] } } }),
  ];
  for (const text of bad) expect(await importCharacterFile(a, text)).toMatchObject({ ok: false, error: expect.any(String) });
  expect(await a.characters.list()).toEqual([]);
});
