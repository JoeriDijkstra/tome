// tome-pack: validate and build Tome content packs (`npm run tome-pack -- …`). See docs/SPEC.md → Pack development.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { zipSync } from 'fflate';

import { buildPackSet, type Issue, type PackFiles } from '../src/engine/index';

const USAGE = `usage:
  npm run tome-pack -- validate <pack-dir> [--major <major-dir>]   same checks as the import dialog
  npm run tome-pack -- build    <pack-dir> [--major <major-dir>] [--out <dir>]   validate, then zip to <out>/<id>-<version>.zip`;

// npm runs scripts from the package root; paths are relative to where the command was typed
const here = (p: string) => resolve(process.env.INIT_CWD ?? '.', p);

function readFolder(dir: string): PackFiles {
  const files: PackFiles = new Map();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      // symlinks could pull files from outside the pack folder into the zip
      if (e.name === '.DS_Store' || e.name.startsWith('.git') || e.isSymbolicLink()) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else files.set(relative(dir, full), readFileSync(full));
    }
  };
  walk(dir);
  return files;
}

function validate(dir: string, majorDir?: string): { files: PackFiles; issues: Issue[] } {
  const files = readFolder(dir);
  // an expansion is checked on top of its major pack
  const { issues } = majorDir ? buildPackSet(readFolder(majorDir), [files]) : buildPackSet(files);
  return { files, issues };
}

function report(issues: Issue[]): boolean {
  for (const i of issues) console.log(`${i.level === 'error' ? '✗' : '!'} ${i.at}  ${i.message}`);
  const errors = issues.filter((i) => i.level === 'error').length;
  console.log(errors ? `${errors} error(s)` : `ok${issues.length ? ` (${issues.length} warning(s))` : ''}`);
  return errors === 0;
}

function main(argv: string[]): number {
  const [cmd, dir, ...rest] = argv;
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if ((cmd !== 'validate' && cmd !== 'build') || !dir) { console.error(USAGE); return 2; }
  const major = flag('--major');
  for (const d of [dir, major]) if (d && !existsSync(here(d))) { console.error(`no such folder: ${d}`); return 2; }
  const { files, issues } = validate(here(dir), major && here(major));
  if (!report(issues)) return 1;
  if (cmd === 'validate') return 0;

  const manifest: { id: string; version: string } = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  const out = here(flag('--out') ?? 'dist');
  mkdirSync(out, { recursive: true });
  const target = join(out, `${manifest.id}-${manifest.version}.zip`);
  writeFileSync(target, zipSync(Object.fromEntries(files)));
  console.log(`→ ${target}`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
