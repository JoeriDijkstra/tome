import { analyze, evaluate, type EvalCtx, FormulaError, parse, parseTemplate } from '../formula';

const roots: Record<string, unknown> = {
  n: 5,
  missing: null,
  abilities: { str: 14, dex: 8 },
  classes: { fighter: { level: 3 }, mystic: { level: 2 } },
  cards: [{ card: 'parry', on: true }, { card: 'mend', on: false }],
};
const warnings: string[] = [];
const ctx: EvalCtx = {
  budget: { steps: 1e6, nest: 0 },
  root: (n) => roots[n] ?? null,
  vars: { input: { amount: 7 } },
  table: (id) => (id === 'prof' ? { id, key: 'level', rows: [{ level: 1, bonus: 2 }, { level: 5, bonus: 3 }] } : undefined),
  entity: (id) => (id === 'parry' ? { id, data: { level: 1 } } : null),
  entities: () => [{ id: 'parry', data: { level: 1 } }, { id: 'mend', data: { level: 2 } }],
  warn: (m) => { warnings.push(m); },
};
const ev = (src: string) => evaluate(parse(src), ctx);

describe('formula language', () => {
  test('precedence, ternary and ?? follow the spec', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('@n > 3 ? 1 : 2')).toBe(1);
    expect(ev('@missing ?? 4 + 1')).toBe(5);
    expect(ev('-@n + 2')).toBe(-3);
    expect(ev('!(@n > 3) || @n == 5')).toBe(true);
  });

  test('null propagates through arithmetic and makes ordering comparisons false', () => {
    expect(ev('@missing + 1')).toBeNull();
    expect(ev('@classes.wizard.level * 2')).toBeNull();
    expect(ev('@classes.wizard.level >= 1')).toBe(false);
    expect(ev('@classes.wizard.level < 1')).toBe(false);
    expect(ev('(@classes.wizard.level ?? 0) + 1')).toBe(1);
    expect(ev('@missing ? 1 : 2')).toBe(2);
    expect(ev('@missing == null')).toBe(true);
  });

  test('equality is strict and division by zero is null', () => {
    expect(ev("1 == '1'")).toBe(false);
    expect(ev('@n / 0')).toBeNull();
    expect(ev('@n % 0')).toBeNull();
  });

  test('type errors evaluate to null and warn', () => {
    warnings.length = 0;
    expect(ev("'a' + 1")).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test('dynamic indexing and object/list literals', () => {
    expect(ev("@abilities['str']")).toBe(14);
    expect(ev("@abilities[$input.amount > 5 ? 'str' : 'dex']")).toBe(14);
    expect(ev('{level: 1, rolls: [1, 2]}')).toEqual({ level: 1, rolls: [1, 2] });
  });

  test('higher-order functions bind $v and $k per element; nested calls rebind $v', () => {
    expect(ev('sum(@classes, $v.level)')).toBe(5);
    expect(ev("count(@classes, $k != 'fighter')")).toBe(1);
    expect(ev('count(@cards, $v.on)')).toBe(1);
    expect(ev('map(@cards, $v.card)')).toEqual(['parry', 'mend']);
    // filter keeps the elements (values, not keys) whose predicate holds, in order
    expect(ev('filter(@cards, $v.on)')).toEqual([{ card: 'parry', on: true }]);
    expect(ev("map(filter(@classes, $k != 'fighter'), $v.level)")).toEqual([2]);
    expect(ev("entities('x', $v.data.level > 1)")).toEqual([{ id: 'mend', data: { level: 2 } }]);
    expect(ev("entities('x', !has(map(@cards, $v.card), $v.id))")).toEqual([]);
  });

  test('library functions', () => {
    expect(ev("lookup('prof', 5, 'bonus')")).toBe(3);
    expect(ev("lookup('prof', 9, 'bonus')")).toBeNull();
    expect(ev('fmt_signed(floor((@abilities.dex - 10) / 2))')).toBe('-1');
    expect(ev('fmt_signed(0)')).toBe('+0');
    expect(ev("concat('L', @missing, 3)")).toBe('L3');
    expect(ev("join(['a', @missing, 'b'])")).toBe('a, b');
    expect(ev("join([1, 2], '/')")).toBe('1/2');
    expect(ev('join(@n)')).toBeNull();
    expect(ev('clamp(@n, 0, 3)')).toBe(3);
    expect(ev('min(@n, @missing)')).toBeNull();
    expect(ev("has(@classes, 'fighter')")).toBe(true);
  });

  test('prototype members are never reachable', () => {
    expect(ev('@abilities.constructor')).toBeNull();
    expect(ev("@abilities['__proto__']")).toBeNull();
  });

  test('parse errors: bare names, unknown functions, arity, node budget', () => {
    expect(() => parse('level + 1')).toThrow(/did you mean @level/);
    expect(() => parse('explode(1)')).toThrow(FormulaError);
    expect(() => parse('clamp(1, 2)')).toThrow(/clamp/);
    expect(() => parse(Array(300).fill('1').join(' + '))).toThrow(/500 nodes/);
    expect(() => parse('1 +')).toThrow(FormulaError);
  });

  test('text templates: literal text, {formula} parts, escaped braces, null renders empty', () => {
    const tx = (s: string) => evaluate(parseTemplate(s), ctx);
    expect(tx('Features')).toBe('Features');
    expect(tx('')).toBe('');
    expect(tx('Level {@n} ({@missing})')).toBe('Level 5 ()');
    expect(tx('{{literal}} {fmt_signed(@n)}')).toBe('{literal} +5');
    expect(tx("{concat('}', {x: 1}.x)}")).toBe('}1');
    expect(() => parseTemplate('oops }')).toThrow(/unmatched '}'/);
    expect(() => parseTemplate('Level {@n')).toThrow(/unclosed '{'/);
    expect(() => parseTemplate('{level}')).toThrow(/did you mean @level/);
  });

  test('analyze reports static reference paths up to the first computed key', () => {
    const a = analyze(parse('@res.hp.max + @mods[$v.data.stat] + @base.x + count(@cards, $v.on)'));
    expect(a.refs).toEqual([['res', 'hp', 'max'], ['mods'], ['base', 'x'], ['cards']]);
    expect(a.vars).toEqual(['v', 'v']);
    expect(a.calls.map((c) => c.fn)).toEqual(['count']);
  });
});
