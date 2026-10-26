// docs/SPEC.md → Architecture: the app knows no game system, and never bundles pack content.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..');
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx|json)$/.test(e.name) ? [join(dir, e.name)] : []));

test('nothing under src/ names a game system or imports from packs/', () => {
  const offenders = sources(SRC).filter((file) => file !== __filename).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    const hits = [
      /\b(dnd|d&d|spells?|hit points|pathfinder|pf2e|daggerheart)\b/i.exec(text)?.[0],
      /from\s+['"][^'"]*\bpacks\//.exec(text)?.[0],
    ].filter(Boolean);
    return hits.map((h) => `${relative(SRC, file)}: ${h}`);
  });
  expect(offenders).toEqual([]);
});

test('src/engine imports no React, Expo or React Native', () => {
  const offenders = sources(join(SRC, 'engine'))
    .filter((f) => !f.includes('__tests__') && !f.includes('__fixtures__'))
    .filter((f) => /from\s+['"](react|react-native|expo[^'"]*)['"]/.test(readFileSync(f, 'utf8')));
  expect(offenders).toEqual([]);
});
