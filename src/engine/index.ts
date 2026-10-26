// Public engine API. Pure TypeScript: no React, Expo or React Native imports anywhere under src/engine.
import { compile, type Compiled } from './compile';
import { type Issue, loadPack, type PackFiles } from './load';
import { mergePacks } from './merge';

export { compile, parsePath, RESERVED, type Compiled } from './compile';
export { runAction, runBatch, runCreation, type Answer, type PromptRequest, type RunOptions, type RunResult } from './effects';
export { createView, reconcile, type Breakdown, type ResourceState, type State, type View } from './evaluate';
export { analyze, evaluate, FormulaError, parse, truthy } from './formula';
export { LIMITS, loadPack, stripTopFolder, unzip, type Issue, type PackFiles, type RawPack } from './load';
export { mergePacks, mergePatch, resolutionKey, resolvePins, type CharacterPins, type Installed, type Pin } from './merge';
export { SUPPORTED_SCHEMA_VERSIONS, type Manifest } from './schema';

/** Load, merge and compile a major pack plus expansions (in order). Stops at the first stage with errors. */
export function buildPackSet(major: PackFiles, expansions: PackFiles[] = []): { compiled?: Compiled; issues: Issue[] } {
  try {
    const loaded = [major, ...expansions].map(loadPack);
    const issues = loaded.flatMap((l) => l.issues);
    if (loaded.some((l) => !l.pack)) return { issues };
    const [first, ...rest] = loaded.map((l) => l.pack!);
    const merged = mergePacks(first, rest);
    issues.push(...merged.issues);
    if (!merged.merged) return { issues };
    const result = compile(merged.merged);
    return { compiled: result.compiled, issues: [...issues, ...result.issues] };
  } catch (e) {
    // a pack must never crash the import dialog; anything unforeseen becomes an error to show
    return { issues: [{ level: 'error', at: 'pack', message: `could not read this pack: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}
