// Storage contract. Local SQLite today; an HTTP server adapter later implements the same interface.
// See docs/SPEC.md → Data adapter.
import type { CharacterPins, Manifest, PackFiles, State } from '@/engine';

export interface Note {
  id: string;
  title: string;
  /** rich text as HTML */
  body: string;
  updated_at: string;
}

export interface Character {
  id: string;
  /** optimistic concurrency: bumped on every put */
  rev: number;
  name: string;
  created_at: string;
  updated_at: string;
  packs: CharacterPins;
  state: State;
  notes: Note[];
}

export type CharacterSummary = Pick<Character, 'id' | 'name' | 'updated_at' | 'packs'>;

export interface InstalledPack {
  id: string;
  version: string;
  kind: Manifest['kind'];
  schema_version: number;
  installed_at: string;
  manifest: Manifest;
}

/** `put` with an `expectedRev` that no longer matches what's stored. */
export class ConflictError extends Error {}

export interface DataAdapter {
  characters: {
    list(): Promise<CharacterSummary[]>;
    get(id: string): Promise<Character | null>;
    /** `expectedRev: null` creates. Returns the stored document with its new rev. Throws ConflictError. */
    put(doc: Character, expectedRev: number | null): Promise<Character>;
    delete(id: string): Promise<void>;
  };
  packs: {
    list(): Promise<InstalledPack[]>;
    files(id: string, version: string): Promise<string[]>;
    readFile(id: string, version: string, path: string): Promise<Uint8Array>;
    /** Called only with files the engine has validated. Replaces an installed copy of the same version. */
    install(manifest: Manifest, files: PackFiles): Promise<void>;
    uninstall(id: string, version: string): Promise<void>;
  };
}
