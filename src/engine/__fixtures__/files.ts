import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { PackFiles } from '../load';

/** A fixture folder as PackFiles; `edit` rewrites JSON files (callbacks declare the shape they expect). */
export function fixture(name: string, edit: Record<string, (json: never) => unknown> = {}): PackFiles {
  const root = join(__dirname, name);
  const files: PackFiles = new Map();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const path = relative(root, full);
      let bytes: Uint8Array = readFileSync(full);
      // test-only: the callback states the file's shape; a wrong shape fails the test that wrote it
      if (edit[path]) bytes = new TextEncoder().encode(JSON.stringify(edit[path](JSON.parse(new TextDecoder().decode(bytes)) as never)));
      files.set(path, bytes);
    }
  };
  walk(root);
  return files;
}

export function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
