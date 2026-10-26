// Local adapter: characters as JSON documents in SQLite, pack files unzipped under documents/packs/<id>/<version>/.
// See docs/SPEC.md → Data adapter.
import { Directory, File, Paths } from 'expo-file-system';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { Manifest, PackFiles } from '@/engine';

import { type Character, type CharacterSummary, ConflictError, type DataAdapter, type InstalledPack } from './adapter';

// each entry upgrades the schema by one version (PRAGMA user_version)
const MIGRATIONS = [
  `CREATE TABLE characters (
     id TEXT PRIMARY KEY NOT NULL,
     name TEXT NOT NULL,
     major_id TEXT NOT NULL,
     rev INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     doc TEXT NOT NULL
   );
   CREATE TABLE packs (
     id TEXT NOT NULL,
     version TEXT NOT NULL,
     kind TEXT NOT NULL,
     schema_version INTEGER NOT NULL,
     installed_at TEXT NOT NULL,
     manifest TEXT NOT NULL,
     files TEXT NOT NULL,
     PRIMARY KEY (id, version)
   );`,
];

let opened: Promise<SQLiteDatabase> | undefined;
function db(): Promise<SQLiteDatabase> {
  opened ??= (async () => {
    const d = await openDatabaseAsync('tome.db');
    await d.execAsync('PRAGMA journal_mode = WAL;');
    const row = await d.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    for (let v = row?.user_version ?? 0; v < MIGRATIONS.length; v++) {
      await d.withExclusiveTransactionAsync(async (txn) => {
        await txn.execAsync(MIGRATIONS[v]);
        await txn.execAsync(`PRAGMA user_version = ${v + 1}`);
      });
    }
    return d;
  })();
  return opened;
}

const packDir = (id: string, version: string) => new Directory(Paths.document, 'packs', id, version);
const packFile = (id: string, version: string, path: string) => new File(packDir(id, version), ...path.split('/'));

export const sqliteAdapter: DataAdapter = {
  characters: {
    async list() {
      const rows = await (await db()).getAllAsync<{ doc: string }>('SELECT doc FROM characters ORDER BY updated_at DESC');
      return rows.map((r): CharacterSummary => {
        const { id, name, updated_at, packs } = JSON.parse(r.doc) as Character;
        return { id, name, updated_at, packs };
      });
    },
    async get(id) {
      const row = await (await db()).getFirstAsync<{ doc: string }>('SELECT doc FROM characters WHERE id = ?', id);
      return row ? (JSON.parse(row.doc) as Character) : null;
    },
    async put(doc, expectedRev) {
      const d = await db();
      const next: Character = { ...doc, rev: (expectedRev ?? 0) + 1, updated_at: new Date().toISOString() };
      const values = [next.name, next.packs.major.id, next.rev, next.updated_at, JSON.stringify(next)];
      const result = expectedRev === null
        ? await d.runAsync('INSERT OR IGNORE INTO characters (name, major_id, rev, updated_at, doc, id) VALUES (?, ?, ?, ?, ?, ?)', ...values, next.id)
        : await d.runAsync('UPDATE characters SET name = ?, major_id = ?, rev = ?, updated_at = ?, doc = ? WHERE id = ? AND rev = ?', ...values, next.id, expectedRev);
      if (result.changes !== 1) throw new ConflictError(`character ${doc.id} changed since rev ${expectedRev ?? 'new'}`);
      return next;
    },
    async delete(id) {
      await (await db()).runAsync('DELETE FROM characters WHERE id = ?', id);
    },
  },
  packs: {
    async list() {
      const rows = await (await db()).getAllAsync<{ manifest: string; installed_at: string }>('SELECT manifest, installed_at FROM packs ORDER BY id, version');
      return rows.map((r): InstalledPack => {
        const manifest = JSON.parse(r.manifest) as Manifest;
        return { id: manifest.id, version: manifest.version, kind: manifest.kind, schema_version: manifest.schema_version, installed_at: r.installed_at, manifest };
      });
    },
    async files(id, version) {
      const row = await (await db()).getFirstAsync<{ files: string }>('SELECT files FROM packs WHERE id = ? AND version = ?', id, version);
      return row ? (JSON.parse(row.files) as string[]) : [];
    },
    readFile: (id, version, path) => packFile(id, version, path).bytes(),
    async install(manifest: Manifest, files: PackFiles) {
      // files first, then the index row: a crash in between leaves unreferenced files, never a row without files
      const dir = packDir(manifest.id, manifest.version);
      if (dir.exists) dir.delete();
      dir.create({ intermediates: true });
      for (const [path, bytes] of files) {
        const file = packFile(manifest.id, manifest.version, path);
        file.create({ intermediates: true });
        await file.write(bytes);
      }
      await (await db()).runAsync(
        'INSERT OR REPLACE INTO packs (id, version, kind, schema_version, installed_at, manifest, files) VALUES (?, ?, ?, ?, ?, ?, ?)',
        manifest.id, manifest.version, manifest.kind, manifest.schema_version, new Date().toISOString(), JSON.stringify(manifest), JSON.stringify([...files.keys()]),
      );
    },
    async uninstall(id, version) {
      await (await db()).runAsync('DELETE FROM packs WHERE id = ? AND version = ?', id, version);
      const dir = packDir(id, version);
      if (dir.exists) dir.delete();
    },
  },
};
