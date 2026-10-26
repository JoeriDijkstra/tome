// Formula language: tokenizer, Pratt parser, evaluator. See docs/SPEC.md → Formula language.
// No eval/Function; every formula terminates (no loops, no recursion, node budget).

export type Ast =
  | { t: 'lit'; v: unknown }
  | { t: 'list'; items: Ast[] }
  | { t: 'obj'; entries: [string, Ast][] }
  | { t: 'ref'; name: string }
  | { t: 'var'; name: string }
  | { t: 'get'; obj: Ast; key: string | Ast }
  | { t: 'un'; op: '!' | '-'; a: Ast }
  | { t: 'bin'; op: string; a: Ast; b: Ast }
  | { t: 'cond'; c: Ast; a: Ast; b: Ast }
  | { t: 'call'; fn: string; args: Ast[] };

export class FormulaError extends Error {}

/** A formula stored as entity data (`formula` field type); evaluated in the reader's context. */
export class FormulaValue {
  constructor(readonly src: string, readonly ast: Ast) {}
}

export interface Table {
  id: string;
  key: string;
  rows: Record<string, unknown>[];
}

/** Shared by every context derived from one top-level evaluation (withVars keeps the same object). */
export interface Budget {
  steps: number;
  nest: number;
}

export interface EvalCtx {
  budget: Budget;
  root(name: string): unknown;
  vars: Record<string, unknown>;
  table(id: string): Table | undefined;
  entity(id: string): unknown;
  entities(type: string): Record<string, unknown>[];
  warn(message: string): void;
}

export const MAX_NODES = 500;
export const MAX_LENGTH = 4000;
/** evaluation steps per top-level evaluation: keeps nested sum/map/count from running for minutes */
export const MAX_STEPS = 1_000_000;
const MAX_FORMULA_NEST = 16;
const MAX_DEPTH = 32;

// name → [min args, max args]
const FUNCTIONS: Record<string, [number, number]> = {
  floor: [1, 1], ceil: [1, 1], round: [1, 1], abs: [1, 1],
  min: [1, Infinity], max: [1, Infinity], clamp: [3, 3],
  sum: [1, 2], count: [1, 2], map: [2, 2], has: [2, 2], len: [1, 1],
  lookup: [3, 3], entity: [1, 1], entities: [1, 2],
  concat: [0, Infinity], fmt_signed: [1, 1],
};

// ---------- tokenizer ----------

type Tok =
  | { k: 'num'; v: number; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'id'; v: string; pos: number }
  | { k: 'op'; v: string; pos: number }
  | { k: 'end'; pos: number };

const OPS = ['??', '==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '.', ',', '(', ')', '[', ']', '{', '}', '@', '$'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new FormulaError(`unterminated string at ${i}`);
      out.push({ k: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`unexpected '${c}' at ${i}`);
    out.push({ k: 'op', v: op, pos: i });
    i += op.length;
  }
  out.push({ k: 'end', pos: src.length });
  return out;
}

// ---------- parser ----------

const BINARY: Record<string, number> = {
  '??': 2, '||': 3, '&&': 4, '==': 5, '!=': 5, '<': 6, '<=': 6, '>': 6, '>=': 6,
  '+': 7, '-': 7, '*': 8, '/': 8, '%': 8,
};

export function parse(src: string): Ast {
  if (src.length > MAX_LENGTH) throw new FormulaError(`formula is longer than ${MAX_LENGTH} characters`);
  const toks = tokenize(src);
  let p = 0;
  let nodes = 0;
  const node = <T extends Ast>(n: T): T => {
    if (++nodes > MAX_NODES) throw new FormulaError(`formula exceeds ${MAX_NODES} nodes`);
    return n;
  };
  const peek = (): Tok => toks[p];
  const isOp = (v: string) => { const t = toks[p]; return t.k === 'op' && t.v === v; };
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`expected '${v}' at ${peek().pos}`);
    p++;
  };
  const ident = (): string => {
    const t = toks[p];
    if (t.k !== 'id') throw new FormulaError(`expected a name at ${t.pos}`);
    p++;
    return t.v;
  };

  function expr(depth: number, minPrec = 0): Ast {
    if (depth > MAX_DEPTH) throw new FormulaError('formula nested too deeply');
    let left = unary(depth + 1);
    for (;;) {
      const t = peek();
      if (t.k !== 'op') break;
      if (t.v === '?' && minPrec <= 1) {
        p++;
        const a = expr(depth + 1, 1);
        expect(':');
        const b = expr(depth + 1, 1);
        left = node({ t: 'cond', c: left, a, b });
        continue;
      }
      const prec = BINARY[t.v];
      if (prec === undefined || prec < minPrec) break;
      p++;
      left = node({ t: 'bin', op: t.v, a: left, b: expr(depth + 1, prec + 1) });
    }
    return left;
  }

  function unary(depth: number): Ast {
    if (isOp('!') || isOp('-')) {
      const op = isOp('!') ? '!' : '-';
      p++;
      return node({ t: 'un', op, a: unary(depth + 1) });
    }
    return postfix(primary(depth), depth);
  }

  function postfix(base: Ast, depth: number): Ast {
    for (;;) {
      if (isOp('.')) { p++; base = node({ t: 'get', obj: base, key: ident() }); continue; }
      if (isOp('[')) { p++; const key = expr(depth + 1); expect(']'); base = node({ t: 'get', obj: base, key }); continue; }
      return base;
    }
  }

  function primary(depth: number): Ast {
    const t = peek();
    if (t.k === 'num' || t.k === 'str') { p++; return node({ t: 'lit', v: t.v }); }
    if (t.k === 'op') {
      if (t.v === '@') { p++; return node({ t: 'ref', name: ident() }); }
      if (t.v === '$') { p++; return node({ t: 'var', name: ident() }); }
      if (t.v === '(') { p++; const e = expr(depth + 1); expect(')'); return e; }
      if (t.v === '[') {
        p++;
        const items: Ast[] = [];
        while (!isOp(']')) { items.push(expr(depth + 1)); if (!isOp(']')) expect(','); }
        p++;
        return node({ t: 'list', items });
      }
      if (t.v === '{') {
        p++;
        const entries: [string, Ast][] = [];
        while (!isOp('}')) {
          const k = ident();
          expect(':');
          entries.push([k, expr(depth + 1)]);
          if (!isOp('}')) expect(',');
        }
        p++;
        return node({ t: 'obj', entries });
      }
    }
    if (t.k === 'id') {
      p++;
      if (t.v === 'true' || t.v === 'false') return node({ t: 'lit', v: t.v === 'true' });
      if (t.v === 'null') return node({ t: 'lit', v: null });
      if (!isOp('(')) throw new FormulaError(`unknown name '${t.v}' at ${t.pos} (did you mean @${t.v}?)`);
      const arity = FUNCTIONS[t.v];
      if (!arity) throw new FormulaError(`unknown function '${t.v}'`);
      p++;
      const args: Ast[] = [];
      while (!isOp(')')) { args.push(expr(depth + 1)); if (!isOp(')')) expect(','); }
      p++;
      if (args.length < arity[0] || args.length > arity[1]) throw new FormulaError(`${t.v}() takes ${arity[0]}${arity[1] === arity[0] ? '' : '+'} arguments`);
      return node({ t: 'call', fn: t.v, args });
    }
    throw new FormulaError(t.k === 'end' ? 'unexpected end of formula' : `unexpected token at ${t.pos}`);
  }

  const ast = expr(0);
  if (peek().k !== 'end') throw new FormulaError(`unexpected token at ${peek().pos}`);
  return ast;
}

/** JSON values in formula positions: numbers/booleans/null are literals, strings are formulas. */
export function parseValue(v: unknown): Ast {
  return typeof v === 'string' ? parse(v) : { t: 'lit', v: v ?? null };
}

// ---------- static analysis ----------

export interface Analysis {
  /** Every `@` reference as its leading static segments: `@res.hp.max` → ['res','hp','max'], `@mods[$x].y` → ['mods']. */
  refs: string[][];
  vars: string[];
  calls: { fn: string; args: Ast[] }[];
}

export function analyze(ast: Ast): Analysis {
  const out: Analysis = { refs: [], vars: [], calls: [] };
  const walk = (n: Ast): void => {
    // a reference chain: @root followed by gets; static keys extend the path until the first computed key
    let base: Ast = n;
    const chain: (string | Ast)[] = [];
    while (base.t === 'get') { chain.unshift(base.key); base = base.obj; }
    if (base.t === 'ref') {
      const path = [base.name];
      let open = true;
      for (const key of chain) {
        if (typeof key === 'string') { if (open) path.push(key); }
        else { open = false; walk(key); }
      }
      out.refs.push(path);
      return;
    }
    if (n.t === 'var') out.vars.push(n.name);
    if (n.t === 'call') out.calls.push(n);
    children(n).forEach(walk);
  };
  walk(ast);
  return out;
}

function children(n: Ast): Ast[] {
  switch (n.t) {
    case 'list': return n.items;
    case 'obj': return n.entries.map((e) => e[1]);
    case 'get': return typeof n.key === 'string' ? [n.obj] : [n.obj, n.key];
    case 'un': return [n.a];
    case 'bin': return [n.a, n.b];
    case 'cond': return [n.c, n.a, n.b];
    case 'call': return n.args;
    default: return [];
  }
}

// ---------- evaluator ----------

export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v !== '';
  return true;
}

export function withVars(ctx: EvalCtx, extra: Record<string, unknown>): EvalCtx {
  return { ...ctx, vars: { ...ctx.vars, ...extra } };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function elements(v: unknown): [unknown, unknown][] | null {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  if (v && typeof v === 'object') return Object.entries(v);
  return null;
}

export function get(obj: unknown, key: unknown, ctx: EvalCtx): unknown {
  if (obj === null || obj === undefined || key === null || key === undefined) return null;
  let v: unknown = null;
  if (Array.isArray(obj)) {
    if (typeof key === 'number') v = obj[key] ?? null;
  } else if (typeof obj === 'object' && (typeof key === 'string' || typeof key === 'number')) {
    const k = String(key);
    if (Object.hasOwn(obj, k)) v = (obj as Record<string, unknown>)[k];
  }
  if (!(v instanceof FormulaValue)) return v ?? null;
  // formula fields are data the import check can't see into, so they can loop: cap the nesting
  if (ctx.budget.nest >= MAX_FORMULA_NEST) throw new FormulaError('formula fields nest too deeply');
  ctx.budget.nest++;
  try {
    return evaluate(v.ast, ctx);
  } finally {
    ctx.budget.nest--;
  }
}

export function evaluate(n: Ast, ctx: EvalCtx): unknown {
  if (--ctx.budget.steps < 0) throw new FormulaError('formula is too expensive to evaluate');
  switch (n.t) {
    case 'lit': return n.v;
    case 'list': return n.items.map((i) => evaluate(i, ctx));
    case 'obj': return Object.fromEntries(n.entries.map(([k, v]) => [k, evaluate(v, ctx)]));
    case 'ref': return ctx.root(n.name) ?? null;
    case 'var': return Object.hasOwn(ctx.vars, n.name) ? ctx.vars[n.name] ?? null : null;
    case 'get': return get(evaluate(n.obj, ctx), typeof n.key === 'string' ? n.key : evaluate(n.key, ctx), ctx);
    case 'un': {
      const a = evaluate(n.a, ctx);
      if (n.op === '!') return !truthy(a);
      if (a === null) return null;
      if (!isNum(a)) return typeErr(ctx, `cannot negate ${typeof a}`);
      return -a;
    }
    case 'cond': return truthy(evaluate(n.c, ctx)) ? evaluate(n.a, ctx) : evaluate(n.b, ctx);
    case 'bin': return binary(n.op, n.a, n.b, ctx);
    case 'call': return call(n.fn, n.args, ctx);
  }
}

function typeErr(ctx: EvalCtx, message: string): null {
  ctx.warn(message);
  return null;
}

function binary(op: string, an: Ast, bn: Ast, ctx: EvalCtx): unknown {
  if (op === '&&') return truthy(evaluate(an, ctx)) && truthy(evaluate(bn, ctx));
  if (op === '||') return truthy(evaluate(an, ctx)) || truthy(evaluate(bn, ctx));
  const a = evaluate(an, ctx);
  if (op === '??') return a ?? evaluate(bn, ctx);
  const b = evaluate(bn, ctx);
  if (op === '==') return a === b;
  if (op === '!=') return a !== b;
  if (op === '<' || op === '<=' || op === '>' || op === '>=') {
    if (a === null || b === null) return false;
    if (!((isNum(a) && isNum(b)) || (typeof a === 'string' && typeof b === 'string'))) {
      typeErr(ctx, `cannot compare ${typeof a} with ${typeof b}`);
      return false;
    }
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  }
  if (a === null || b === null) return null;
  if (!isNum(a) || !isNum(b)) return typeErr(ctx, `'${op}' needs numbers, got ${typeof a} and ${typeof b}`);
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? null : a / b;
    case '%': return b === 0 ? null : a % b;
  }
  return null;
}

function num(v: unknown, ctx: EvalCtx, fn: string): number | null {
  if (v === null || v === undefined) return null;
  if (!isNum(v)) return typeErr(ctx, `${fn}() needs a number, got ${typeof v}`);
  return v;
}

function call(fn: string, args: Ast[], ctx: EvalCtx): unknown {
  // higher-order functions evaluate their second argument per element
  if (fn === 'sum' || fn === 'count') {
    const els = elements(evaluate(args[0], ctx));
    if (!els) return null;
    let total = 0;
    for (const [k, v] of els) {
      const r = args[1] ? evaluate(args[1], withVars(ctx, { v, k })) : v;
      if (fn === 'count') { if (args[1] ? truthy(r) : true) total++; continue; }
      const x = num(r, ctx, 'sum');
      if (x === null) return null;
      total += x;
    }
    return total;
  }
  if (fn === 'map') {
    const els = elements(evaluate(args[0], ctx));
    return els ? els.map(([k, v]) => evaluate(args[1], withVars(ctx, { v, k }))) : null;
  }
  if (fn === 'entities') {
    const type = evaluate(args[0], ctx);
    if (typeof type !== 'string') return null;
    const all = ctx.entities(type);
    return args[1] ? all.filter((v) => truthy(evaluate(args[1], withVars(ctx, { v, k: v.id })))) : all;
  }
  const v = args.map((a) => evaluate(a, ctx));
  switch (fn) {
    case 'floor': case 'ceil': case 'round': case 'abs': {
      const x = num(v[0], ctx, fn);
      return x === null ? null : Math[fn](x);
    }
    case 'min': case 'max': {
      const list = v.length === 1 && Array.isArray(v[0]) ? v[0] : v;
      if (list.length === 0) return null;
      const xs = list.map((x) => num(x, ctx, fn));
      return xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => Math[fn](a, b));
    }
    case 'clamp': {
      const [x, lo, hi] = v.map((a) => num(a, ctx, fn));
      return x === null || lo === null || hi === null ? null : Math.min(hi, Math.max(lo, x));
    }
    case 'has': {
      const [list, id] = v;
      if (Array.isArray(list)) return list.includes(id);
      if (list && typeof list === 'object' && typeof id === 'string') return Object.hasOwn(list, id);
      return false;
    }
    case 'len': {
      const x = v[0];
      if (Array.isArray(x) || typeof x === 'string') return x.length;
      if (x && typeof x === 'object') return Object.keys(x).length;
      return null;
    }
    case 'lookup': {
      const [id, rowKey, col] = v;
      const table = typeof id === 'string' ? ctx.table(id) : undefined;
      if (!table || typeof col !== 'string') return null;
      const row = table.rows.find((r) => r[table.key] === rowKey);
      return row && Object.hasOwn(row, col) ? row[col] ?? null : null;
    }
    case 'entity': return typeof v[0] === 'string' ? ctx.entity(v[0]) ?? null : null;
    case 'concat': return v.map((x) => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x))).join('');
    case 'fmt_signed': {
      const x = num(v[0], ctx, fn);
      return x === null ? null : x >= 0 ? `+${x}` : String(x);
    }
  }
  return null;
}
