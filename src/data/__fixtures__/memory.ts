import type { Character, DataAdapter, InstalledPack } from '../adapter';
import { ConflictError } from '../adapter';

/** DataAdapter kept in memory: the test seam for pack and character logic. */
export function memoryAdapter(): DataAdapter {
  const characters = new Map<string, Character>();
  const packs = new Map<string, { pack: InstalledPack; files: Map<string, Uint8Array> }>();
  const key = (id: string, version: string) => `${id}@${version}`;
  return {
    characters: {
      list: async () => [...characters.values()].map(({ id, name, updated_at, packs: p }) => ({ id, name, updated_at, packs: p })),
      get: async (id) => characters.get(id) ?? null,
      async put(doc, expectedRev) {
        const stored = characters.get(doc.id);
        if ((stored?.rev ?? null) !== expectedRev) throw new ConflictError(doc.id);
        const next = { ...doc, rev: (expectedRev ?? 0) + 1, updated_at: new Date().toISOString() };
        characters.set(doc.id, next);
        return next;
      },
      delete: async (id) => { characters.delete(id); },
    },
    packs: {
      list: async () => [...packs.values()].map((p) => p.pack),
      files: async (id, version) => [...(packs.get(key(id, version))?.files.keys() ?? [])],
      readFile: async (id, version, path) => packs.get(key(id, version))!.files.get(path)!,
      async install(manifest, files) {
        const pack = { id: manifest.id, version: manifest.version, kind: manifest.kind, schema_version: manifest.schema_version, installed_at: '', manifest };
        packs.set(key(manifest.id, manifest.version), { pack, files: new Map(files) });
      },
      uninstall: async (id, version) => { packs.delete(key(id, version)); },
    },
  };
}
