// Effect batches: sequential, transactional, prompting the UI through a callback; replayable from recorded answers.
// See docs/SPEC.md → Effects, Constraints, Creation wizard.
import type { Compiled } from './compile';
import { createView, getIn, type State, type View } from './evaluate';
import { evaluate, truthy } from './formula';
import { clone } from './json';
import type * as S from './schema';

export const MAX_HOOK_DEPTH = 8;
export const MAX_OPS = 1000;

export type PromptRequest =
  | { kind: 'choose'; entityType: string; options: string[]; count: number; title?: string }
  | { kind: 'modal'; modal: string; with: Record<string, unknown> };
/** `choose` → chosen entity ids; `modal` → the modal's inputs. `null` cancels the whole batch. */
export type Answer = string[] | Record<string, unknown>;

export interface RunOptions {
  /** document name, readable as @name */
  name?: string;
  vars?: Record<string, unknown>;
  prompt?: (request: PromptRequest) => Promise<Answer | null>;
  /** recorded answers to replay, consumed in order before `prompt` is asked */
  answers?: Answer[];
}

export type RunResult =
  | { ok: true; state: State; answers: Answer[] }
  | { ok: false; cancelled: true }
  | { ok: false; rejected: string };

class Reject extends Error {}
class Cancel extends Error {}
/** returned by a write's `next` to leave the stored value untouched */
const SKIP = Symbol('skip');

export async function runBatch(compiled: Compiled, stored: State, effects: S.Effect[], opts: RunOptions = {}): Promise<RunResult> {
  const before = createView(compiled, stored, opts.name);
  const run = new Run(compiled, clone(before.state), opts);
  return run.finish(new Set(before.violations().map((v) => v.id)), () => run.effects(effects, opts.vars ?? {}, 0));
}

/** Run a pack action: its modal (if any) or its effects. */
export function runAction(compiled: Compiled, stored: State, actionId: string, opts: RunOptions = {}): Promise<RunResult> {
  const action = compiled.actions.get(actionId);
  if (!action) return Promise.resolve({ ok: false, rejected: `unknown action '${actionId}'` });
  const effects: S.Effect[] = action.modal ? [{ op: 'open_modal', modal: action.modal }] : action.effects ?? [];
  return runBatch(compiled, stored, effects, opts);
}

/**
 * The wizard's Finish: default state, then every step's effects with its inputs, as one transaction.
 * A new character has no "existing" violations, so every constraint must hold.
 * `through` is the wizard's Next: run the steps up to and including that one, without checking constraints
 * (later steps may still fix them).
 */
export async function runCreation(compiled: Compiled, inputs: Record<string, Record<string, unknown>>, opts: RunOptions & { through?: string } = {}): Promise<RunResult> {
  const all = compiled.creation?.steps ?? [];
  const steps = opts.through === undefined ? all : all.slice(0, all.findIndex((s) => s.id === opts.through) + 1);
  const run = new Run(compiled, clone(createView(compiled, {}, opts.name).state), opts);
  return run.finish(opts.through === undefined ? new Set() : null, async () => {
    for (const step of steps) {
      const input = inputs[step.id] ?? {};
      run.checkInputs(step.fields, input, `step ${step.id}`, { steps: inputs });
      await run.effects(step.effects, { input, steps: inputs }, 0);
    }
  });
}

class Run {
  private view: View | undefined;
  private ops = 0;
  private answerIndex = 0;
  readonly answers: Answer[] = [];

  constructor(private compiled: Compiled, private draft: State, private opts: RunOptions) {}

  /** `existing` violations stay warnings; `null` skips the constraint check (a creation dry-run). */
  async finish(existing: Set<string> | null, body: () => Promise<void>): Promise<RunResult> {
    try {
      await body();
    } catch (e) {
      if (e instanceof Cancel) return { ok: false, cancelled: true };
      if (e instanceof Reject) return { ok: false, rejected: e.message };
      throw e;
    }
    // only violations this batch introduced reject it; existing ones stay warnings
    const added = existing === null ? [] : this.current().violations().filter((v) => !existing.has(v.id));
    if (added.length) return { ok: false, rejected: added[0].message };
    return { ok: true, state: this.draft, answers: this.answers };
  }

  private current(): View {
    this.view ??= createView(this.compiled, this.draft, this.opts.name);
    return this.view;
  }

  private val(src: S.FormulaSrc | undefined, vars: Record<string, unknown>): unknown {
    return src === undefined ? undefined : this.current().eval(src, vars);
  }

  async effects(effects: S.Effect[], vars: Record<string, unknown>, depth: number): Promise<void> {
    if (depth > MAX_HOOK_DEPTH) throw new Reject(`hooks nested deeper than ${MAX_HOOK_DEPTH}`);
    for (const e of effects) {
      if (++this.ops > MAX_OPS) throw new Reject(`more than ${MAX_OPS} effect ops in one batch`);
      await this.op(e, vars, depth);
    }
  }

  private async op(e: S.Effect, vars: Record<string, unknown>, depth: number): Promise<void> {
    switch (e.op) {
      case 'set': return this.write(e.path, vars, () => this.val(e.value, vars));
      case 'add': return this.write(e.path, vars, (cur) => {
        const delta = this.val(e.value, vars);
        if (delta === null) return SKIP;
        if (typeof delta !== 'number') throw new Reject(`add ${e.path}: value is not a number`);
        let n = (typeof cur === 'number' ? cur : 0) + delta;
        const min = this.val(e.min, vars);
        const max = this.val(e.max, vars);
        if (typeof min === 'number') n = Math.max(min, n);
        if (typeof max === 'number') n = Math.min(max, n);
        return n;
      });
      case 'push': return this.write(e.path, vars, (cur) => [...(Array.isArray(cur) ? cur : []), this.val(e.value, vars)]);
      case 'remove': return this.write(e.path, vars, (cur) =>
        Array.isArray(cur) ? cur.filter((v, k) => !truthy(this.val(e.where, { ...vars, v, k }))) : SKIP);
      case 'toggle': return this.write(e.path, vars, (cur) => {
        if (e.value === undefined) return !truthy(cur);
        const v = this.val(e.value, vars);
        const list = Array.isArray(cur) ? cur : [];
        return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
      });
      case 'choose': {
        const options = this.options(e.from.entity_type, e.from.filter, vars);
        const count = Math.min(Number(this.val(e.count, vars) ?? 1), options.length);
        // nothing to choose from: nothing to ask, write or follow up
        if (count <= 0) return;
        const answer = await this.ask({ kind: 'choose', entityType: e.from.entity_type, options, count, title: e.title });
        if (!Array.isArray(answer) || answer.length !== count || new Set(answer).size !== count || answer.some((id) => !options.includes(id))) {
          throw new Reject(`choose ${e.from.entity_type}: expected ${count} different offered options`);
        }
        if (e.into) {
          await this.write(e.into, vars, (cur) =>
            Array.isArray(cur) ? [...cur, ...answer.filter((id) => !cur.includes(id))] : (answer[0] ?? null));
        }
        if (e.then) await this.effects(e.then, { ...vars, choice: answer }, depth);
        return;
      }
      case 'open_modal': {
        const modal = this.compiled.modals.get(e.modal)!;
        const withValues = Object.fromEntries(Object.entries(e.with ?? {}).map(([k, v]) => [k, this.val(v, vars)]));
        const answer = await this.ask({ kind: 'modal', modal: e.modal, with: withValues });
        if (Array.isArray(answer)) throw new Reject(`modal ${e.modal}: expected inputs`);
        const input = { ...withValues, ...answer };
        this.checkInputs(modal.fields, input, `modal ${e.modal}`, vars);
        for (const rule of modal.validate) if (truthy(this.val(rule.when, { ...vars, input }))) throw new Reject(rule.message);
        await this.effects(modal.submit?.effects ?? [], { ...vars, input }, depth);
        return;
      }
      case 'run_hook': {
        const id = this.val(e.entity, vars);
        const entity = typeof id === 'string' ? this.compiled.entities.get(id) : undefined;
        if (!entity) throw new Reject(`run_hook: unknown entity '${String(id)}'`);
        const key = String(this.val(e.key, vars));
        const hooks = Object.hasOwn(entity.hooks, e.hook) ? entity.hooks[e.hook] : {};
        await this.effects(Object.hasOwn(hooks, key) ? hooks[key] : [], { ...vars, self: entity.envelope }, depth + 1);
        return;
      }
      case 'reset': {
        for (const r of this.current().resources()) {
          if (r.reset.includes(e.tag) && r.max !== null) await this.write(`res.${r.id}.current`, vars, () => r.max);
        }
        return;
      }
      case 'if': return this.effects(truthy(this.val(e.when, vars)) ? e.then : e.else ?? [], vars, depth);
    }
  }

  private options(entityType: string, filter: S.FormulaSrc | undefined, vars: Record<string, unknown>): string[] {
    return (this.compiled.byType.get(entityType) ?? [])
      .filter((x) => filter === undefined || truthy(this.val(filter, { ...vars, v: x.envelope, k: x.id })))
      .map((x) => x.id);
  }

  /** Answers are data from the UI or a recording: hold them to what the inputs declare. */
  checkInputs(inputs: S.Input[], values: Record<string, unknown>, where: string, vars: Record<string, unknown>) {
    for (const input of inputs) {
      if (input.visible_when !== undefined && !truthy(this.val(input.visible_when, { ...vars, input: values }))) continue;
      const v = values[input.key];
      const fail = (what: string): never => { throw new Reject(`${where}: '${input.key}' ${what}`); };
      if (v === undefined || v === null || v === '') {
        if (input.required === true) fail('is required');
        continue;
      }
      if (input.type === 'number' || input.type === 'stepper') {
        if (typeof v !== 'number' || !Number.isFinite(v)) fail('must be a number');
        if (typeof input.min === 'number' && (v as number) < input.min) fail(`must be at least ${input.min}`);
        if (typeof input.max === 'number' && (v as number) > input.max) fail(`must be at most ${input.max}`);
      } else if (input.type === 'boolean') {
        if (typeof v !== 'boolean') fail('must be true or false');
      } else if (input.type === 'select' && input.options !== undefined) {
        const options = typeof input.options === 'string' ? this.val(input.options, { ...vars, input: values }) : input.options;
        if (Array.isArray(options) && !options.includes(v)) fail(`must be one of ${options.join(', ')}`);
      } else if (input.type === 'choice') {
        if (!Array.isArray(v) || v.some((id) => typeof id !== 'string')) fail('must be a list of ids');
        const ids = v as string[];
        const allowed = this.options(input.entity_type ?? '', input.filter, { ...vars, input: values });
        if (ids.some((id) => !allowed.includes(id)) || new Set(ids).size !== ids.length) fail('contains an option that was not offered');
        if (typeof input.min === 'number' && ids.length < input.min) fail(`needs at least ${input.min}`);
        if (typeof input.max === 'number' && ids.length > input.max) fail(`allows at most ${input.max}`);
      } else if (input.type === 'allocation' || input.type === 'assign') {
        const keys = input.keys ?? [];
        const o = v as Record<string, unknown>;
        if (typeof v !== 'object' || Array.isArray(v) || Object.keys(o).length !== keys.length || keys.some((k) => typeof o[k] !== 'number'))
          fail(`must give a number to each of ${keys.join(', ')}`);
        const nums = keys.map((k) => o[k] as number);
        if (input.type === 'assign') {
          const want = [...(input.values ?? [])].sort((a, b) => a - b);
          if (nums.sort((a, b) => a - b).some((n, i) => n !== want[i])) fail(`must use each of ${(input.values ?? []).join(', ')} once`);
        } else {
          const table = this.compiled.tables.get(input.cost_table ?? '');
          let spent = 0;
          for (const n of nums) {
            if (typeof input.min === 'number' && n < input.min) fail(`must be at least ${input.min}`);
            if (typeof input.max === 'number' && n > input.max) fail(`must be at most ${input.max}`);
            const cost = table?.rows.find((r) => r[table.key] === n)?.cost;
            if (typeof cost !== 'number') fail(`has no cost for ${n}`);
            spent += cost as number;
          }
          if (spent > (input.budget ?? 0)) fail(`spends ${spent} of ${input.budget} points`);
        }
      }
    }
  }

  private resource(id: string) {
    return this.current().resources().find((r) => r.id === id);
  }

  private async ask(request: PromptRequest): Promise<Answer> {
    let answer: Answer | null | undefined;
    if (this.opts.answers && this.answerIndex < this.opts.answers.length) answer = this.opts.answers[this.answerIndex++];
    else if (this.opts.prompt) answer = await this.opts.prompt(request);
    else throw new Reject(`unanswered ${request.kind === 'choose' ? `choice of ${request.entityType}` : `modal ${request.modal}`}`);
    if (answer === null) throw new Cancel();
    this.answers.push(answer);
    return answer;
  }

  /** Resolve the path, compute the new value from the current one, validate it against the field, write it. */
  private async write(path: string, vars: Record<string, unknown>, next: (cur: unknown) => unknown): Promise<void> {
    const keys: (string | number)[] = [];
    for (const seg of this.compiled.path(path)) {
      const k = typeof seg === 'string' ? seg : evaluate(seg, this.current().ctx(vars));
      if (typeof k !== 'string' && typeof k !== 'number') throw new Reject(`path ${path}: a computed key is not a string or number`);
      keys.push(k);
    }
    let value: unknown;
    if (keys[0] === 'res') {
      const [, id, part] = keys;
      const r = this.resource(String(id));
      if (keys.length !== 3 || !r || (part !== 'current' && part !== 'temp') || (part === 'temp' && r.temp === null)) {
        throw new Reject(`${path}: not a resource value`);
      }
      // resources change from what the sheet shows (current is clamped to max), not the raw stored number
      value = next(part === 'current' ? r.current : r.temp);
      if (value === SKIP) return;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Reject(`${path}: resources hold numbers`);
      value = part === 'current' && r.max !== null ? Math.min(r.max, Math.max(0, value)) : Math.max(0, value);
    } else {
      value = next(getIn(this.draft, keys));
      if (value === SKIP) return;
      value = validateWrite(this.compiled, keys, value, path);
    }
    this.draft = setPath(this.draft, keys, value, path) as State;
    this.view = undefined;
  }
}

/** The field definition a write lands on: list indexes and map keys step into `of`/`fields`. */
function fieldAt(compiled: Compiled, keys: (string | number)[]): S.FieldDef | undefined {
  let def = compiled.fieldByKey.get(String(keys[0]));
  for (const k of keys.slice(1)) {
    if (!def) return undefined;
    if (def.type === 'object') def = def.fields?.find((f) => f.key === k);
    else if (def.type === 'list' || def.type === 'map') {
      if (def.type === 'map') checkMapKey(compiled, def, k);
      def = elementOf(def, String(k));
    } else return undefined;
  }
  return def;
}

function elementOf(def: S.FieldDef, key: string): S.FieldDef {
  return def.of === 'object'
    ? { key, type: 'object', fields: def.fields }
    : { key, type: def.of ?? 'string', entity_type: def.entity_type, options: def.options };
}

function checkMapKey(compiled: Compiled, def: S.FieldDef, k: string | number) {
  if (!def.key_entity_type) return;
  const e = compiled.entities.get(String(k));
  if (!e || e.type !== def.key_entity_type) throw new Reject(`${def.key}: '${String(k)}' is not a ${def.key_entity_type}`);
}

/** Type-check a written value against its field, recursively; numbers are clamped to min/max. */
function validateWrite(compiled: Compiled, keys: (string | number)[], value: unknown, path: string): unknown {
  const def = fieldAt(compiled, keys);
  return def ? validateValue(compiled, def, value, path) : value;
}

function validateValue(compiled: Compiled, def: S.FieldDef, value: unknown, path: string): unknown {
  if (value === null) return value;
  const fail = (what: string): never => { throw new Reject(`${path}: expected ${what}`); };
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  switch (def.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('a number');
      return Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, value as number));
    case 'string': case 'text': return typeof value === 'string' ? value : fail('a string');
    case 'boolean': return typeof value === 'boolean' ? value : fail('true or false');
    case 'select': return def.options?.includes(String(value)) ? value : fail(`one of ${def.options?.join(', ')}`);
    case 'ref': {
      const e = typeof value === 'string' ? compiled.entities.get(value) : undefined;
      return e && (!def.entity_type || e.type === def.entity_type) ? value : fail(`a ${def.entity_type ?? 'entity'} id`);
    }
    case 'list':
      if (!Array.isArray(value)) fail('a list');
      return (value as unknown[]).map((v, i) => validateValue(compiled, elementOf(def, String(i)), v, `${path}[${i}]`));
    case 'map':
      if (!isObj(value)) fail('an object');
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        checkMapKey(compiled, def, k);
        return [k, validateValue(compiled, elementOf(def, k), v, `${path}.${k}`)];
      }));
    case 'object': {
      if (!isObj(value)) fail('an object');
      // unknown keys pass through (they are kept, like everywhere else)
      const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const sub of def.fields ?? []) if (out[sub.key] !== undefined) out[sub.key] = validateValue(compiled, sub, out[sub.key], `${path}.${sub.key}`);
      return out;
    }
  }
  return value;
}

function setPath(obj: unknown, keys: (string | number)[], value: unknown, path: string): unknown {
  if (keys.length === 0) return value;
  const [k, ...rest] = keys;
  if (Array.isArray(obj)) {
    if (typeof k !== 'number' || k < 0 || k >= obj.length) throw new Reject(`${path}: list index ${String(k)} does not exist`);
    const copy = [...obj];
    copy[k] = setPath(copy[k], rest, value, path);
    return copy;
  }
  // missing intermediate objects and map entries are created
  const base = obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
  return { ...base, [String(k)]: setPath(base[String(k)], rest, value, path) };
}
