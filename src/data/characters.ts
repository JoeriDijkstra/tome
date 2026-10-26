// Character files: `<name>.tome.json`, for sharing a character between devices. See docs/SPEC.md →
// Character export / import. An imported file is untrusted input, so it is checked before it is stored.
import semver from 'semver';
import { z } from 'zod';

import type { Installed } from '@/engine';

import type { Character, DataAdapter } from './adapter';

/** ponytail: time + random; switch to UUIDs when characters sync to a server */
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** a file bigger than this is not a character */
export const MAX_CHARACTER_FILE = 5 * 1024 * 1024;

const Pin = z.strictObject({ id: z.string().min(1), range: z.string().refine((r) => semver.validRange(r) !== null, 'not a version range') });
const CharacterFile = z.object({
  format: z.literal('tome.character'),
  format_version: z.literal(1),
  character: z.object({
    name: z.string().trim().min(1).max(200),
    created_at: z.string().optional(),
    packs: z.strictObject({ major: Pin, expansions: z.array(Pin) }),
    state: z.record(z.string(), z.unknown()),
    notes: z.array(z.strictObject({ id: z.string(), title: z.string(), body: z.string(), updated_at: z.string() })).default([]),
  }),
  resolved: z.array(z.strictObject({ id: z.string(), version: z.string() })).default([]),
});

/** The file for `doc`; `resolved` records which pack versions it was last opened with. */
export function characterFile(doc: Character, resolved: Installed[]): string {
  const { id: _id, rev: _rev, ...character } = doc;
  return JSON.stringify({ format: 'tome.character', format_version: 1, character, resolved }, null, 2);
}

/** A safe file name for the export: `Brienne.tome.json`. */
export const characterFileName = (doc: Character) => `${doc.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'character'}.tome.json`;

export type CharacterImport = { ok: true; doc: Character } | { ok: false; error: string };

/**
 * Store a character file as a new character: a new `id`, `rev` 0. Missing packs don't block the import;
 * the character then opens read-only until they're installed (see SPEC → Resolution).
 */
export async function importCharacterFile(adapter: DataAdapter, text: string): Promise<CharacterImport> {
  if (text.length > MAX_CHARACTER_FILE) return { ok: false, error: 'This file is too large to be a character.' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file isn’t valid JSON.' };
  }
  const parsed = CharacterFile.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `This isn’t a Tome character file (${issue.path.join('.') || 'file'}: ${issue.message}).` };
  }
  const now = new Date().toISOString();
  const c = parsed.data.character;
  const doc = await adapter.characters.put({ ...c, id: newId(), rev: 0, created_at: c.created_at ?? now, updated_at: now }, null);
  return { ok: true, doc };
}
