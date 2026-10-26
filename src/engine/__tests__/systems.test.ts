import type { Compiled } from '../compile';
import { runAction, runBatch, runCreation, type PromptRequest, type RunResult } from '../effects';
import { createView, type State } from '../evaluate';
import { buildPackSet } from '../index';
import { fixture } from '../__fixtures__/files';

function build(name: string): Compiled {
  const { compiled, issues } = buildPackSet(fixture(name));
  expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  return compiled!;
}
function ok(r: RunResult): State {
  if (!r.ok) throw new Error(`batch failed: ${JSON.stringify(r)}`);
  return r.state;
}

describe('fx-sum (summed modifiers, resources, hooks)', () => {
  const c = build('fx-sum');
  let hero: State;

  beforeAll(async () => {
    hero = ok(await runCreation(c, {
      lineage: { lineage: ['stout'] },
      calling: { calling: ['warrior'], skills: ['athletics'] },
      stats: { stats: { might: 15, grace: 13, vigor: 14 } },
    }));
  });

  test('creation + derived values, field modifiers and grants', () => {
    const v = createView(c, hero);
    expect(v.root('stats')).toEqual({ might: 15, grace: 13, vigor: 16 });
    expect(v.eval('@base.stats.vigor')).toBe(14);
    expect(v.root('mods')).toEqual({ might: 2, grace: 1, vigor: 3 });
    expect(v.root('skills')).toEqual({ athletics: 4, stealth: 1 });
    expect(v.root('vigor_max')).toBe(13);
    expect(v.eval('@res.hp.current')).toBe(13);
    expect(v.owned().map((o) => o.entity.id).sort()).toEqual(['darksight', 'stout', 'warrior']);
    expect(v.features().map((f) => f.id)).toEqual(['second_breath']);
    expect(v.explain('stats.vigor')).toMatchObject({ base: 14, value: 16, contributions: [{ source: 'stout', op: 'add', value: 2, applied: true }] });
    expect(v.warnings.size).toBe(0);
  });

  test('owns_when gates equipment; max and add combine in order', () => {
    const gear = (chain: boolean, buckler: boolean) => ({ ...hero, gear: [{ item: 'chain', equipped: chain }, { item: 'buckler', equipped: buckler }] });
    expect(createView(c, gear(false, false)).root('defense')).toBe(11);
    expect(createView(c, gear(true, false)).root('defense')).toBe(16);
    expect(createView(c, gear(true, true)).root('defense')).toBe(18);
    const level2 = { ...gear(true, true), callings: { warrior: { level: 2 } } };
    const v = createView(c, level2);
    expect(v.root('defense')).toBe(19);
    expect(v.explain('defense')?.contributions.map((x) => x.source).sort()).toEqual(['buckler', 'chain', 'warrior']);
  });

  test('damage spends temp first; ops see earlier ops; validation rejects', async () => {
    const withTemp = ok(await runBatch(c, hero, [{ op: 'set', path: 'res.hp.temp', value: 5 }]));
    const hit = ok(await runAction(c, withTemp, 'take_damage', { answers: [{ amount: 8 }] }));
    const v = createView(c, hit);
    expect(v.eval('@res.hp.current')).toBe(10);
    expect(v.eval('@res.hp.temp')).toBe(0);
    expect(await runAction(c, hero, 'take_damage', { answers: [{ amount: -1 }] })).toEqual({ ok: false, rejected: "modal damage: 'amount' must be at least 0" });
  });

  test('writes clamp to field and resource bounds; wrong types reject', async () => {
    const s = ok(await runBatch(c, hero, [
      { op: 'set', path: 'stats.might', value: 99 },
      { op: 'set', path: 'res.hp.current', value: 99 },
    ]));
    expect((s.stats as Record<string, number>).might).toBe(30);
    expect(s.res).toEqual({ hp: { current: 13 } });
    expect(await runBatch(c, hero, [{ op: 'set', path: 'lineage', value: "'warrior'" }])).toMatchObject({ ok: false, rejected: expect.stringMatching(/lineage id/) });
  });

  test('level up runs hooks that prompt; answers replay; cancel rolls back', async () => {
    const l2 = ok(await runAction(c, hero, 'level_up', { answers: [{ calling: ['warrior'] }] }));
    expect(await runAction(c, l2, 'level_up', { answers: [{ calling: ['warrior'] }] })).toEqual({ ok: false, rejected: 'unanswered choice of path' });

    const asked: PromptRequest[] = [];
    const r = await runAction(c, l2, 'level_up', {
      prompt: async (req) => { asked.push(req); return req.kind === 'modal' ? { calling: ['warrior'] } : ['champion']; },
    });
    const l3 = ok(r);
    expect(asked[1]).toEqual({ kind: 'choose', entityType: 'path', options: ['champion', 'sentinel'], count: 1, title: undefined });
    expect(l3.paths).toEqual(['champion']);
    expect(createView(c, l3).root('level')).toBe(3);

    const replay = ok(await runAction(c, l2, 'level_up', { answers: r.ok ? r.answers : [] }));
    expect(replay).toEqual(l3);

    const before = structuredClone(l2);
    expect(await runAction(c, l2, 'level_up', { prompt: async () => null })).toEqual({ ok: false, cancelled: true });
    expect(l2).toEqual(before);
  });

  test('multiclassing adds a new map entry', async () => {
    const s = ok(await runAction(c, hero, 'level_up', { answers: [{ calling: ['mystic'] }] }));
    expect(s.callings).toEqual({ warrior: { level: 1 }, mystic: { level: 1 } });
    expect(createView(c, s).root('vigor_max')).toBe(3 * 2 + 10 + 6);
  });

  test('constraints reject new violations but not existing ones', async () => {
    const l5 = { ...hero, callings: { warrior: { level: 5 } } };
    expect(await runAction(c, l5, 'level_up', { answers: [{ calling: ['warrior'] }] })).toEqual({ ok: false, rejected: 'The highest level is 5.' });
    const l6 = { ...hero, callings: { warrior: { level: 6 } } };
    expect(createView(c, l6).violations()).toEqual([{ id: 'level_cap', message: 'The highest level is 5.' }]);
    expect((await runAction(c, l6, 'long_rest')).ok).toBe(true);
  });

  test('resources: spend, rest resets every tagged pool', async () => {
    const used = ok(await runAction(c, hero, 'use_second_breath'));
    const hurt = ok(await runBatch(c, used, [{ op: 'add', path: 'res.hp.current', value: -5 }]));
    expect(createView(c, hurt).eval('[@res.second_breath.current, @res.hp.current]')).toEqual([1, 8]);
    const rested = ok(await runAction(c, hurt, 'long_rest'));
    expect(createView(c, rested).eval('[@res.second_breath.current, @res.hp.current]')).toEqual([2, 13]);
  });

  test('runaway batches are rejected', async () => {
    const many = Array.from({ length: 1001 }, () => ({ op: 'set' as const, path: 'stats.might', value: 10 }));
    expect(await runBatch(c, hero, many)).toEqual({ ok: false, rejected: 'more than 1000 effect ops in one batch' });
  });

  test('reconcile keeps unknown keys and wrong types, fills defaults', () => {
    const v = createView(c, { legacy: 1, stats: 'oops' });
    expect(v.state.legacy).toBe(1);
    expect(v.state.stats).toBe('oops');
    expect(v.state.gear).toEqual([]);
    expect([...v.warnings]).toEqual(['stats has the wrong type; keeping the stored value']);
  });
});

describe('fx-typed (typed stacking, grants, valued conditions, formula prerequisites)', () => {
  const c = build('fx-typed');

  test('grant chains settle from stored values; circumstance bonuses keep only the highest', () => {
    const l1 = createView(c, { ancestry: 'hillfolk', level: 1 });
    expect(l1.owned().map((o) => o.entity.id)).toEqual(['hillfolk', 'sure_footed']);
    expect(l1.root('leap')).toBe(1);
    const l2 = createView(c, { ancestry: 'hillfolk', level: 2 });
    expect(l2.owned().map((o) => o.entity.id)).toEqual(['hillfolk', 'sure_footed', 'steady']);
    expect(l2.root('leap')).toBe(2);
    expect(l2.explain('leap')?.contributions.map((x) => [x.source, x.applied])).toEqual([['sure_footed', false], ['steady', true]]);
  });

  test('status: worst penalty and best bonus apply separately; $owner carries condition values', () => {
    const v = createView(c, {
      level: 2,
      conditions: [{ condition: 'shaken', value: 2 }, { condition: 'dazed', value: 1 }, { condition: 'blessed' }, { condition: 'pinned' }],
    });
    // 12 base, +1 blessed (status), -2 shaken (status; dazed -1 dropped), -2 exposed (circumstance, granted by pinned)
    expect(v.root('guard')).toBe(9);
    const applied = v.explain('guard')?.contributions.filter((x) => x.applied).map((x) => x.source).sort();
    expect(applied).toEqual(['blessed', 'exposed', 'shaken']);
  });

  test('formula fields evaluate in the chooser’s context', async () => {
    const offered = async (state: State) => {
      let options: string[] = [];
      await runAction(c, state, 'learn_feat', { prompt: async (r) => { if (r.kind === 'choose') options = r.options; return null; } });
      return options;
    };
    expect(await offered({ level: 2, rank: { leap: 0 } })).toEqual(['sure_footed', 'steady', 'quick_step']);
    expect(await offered({ level: 2, rank: { leap: 2 } })).toEqual(['sure_footed', 'steady', 'long_jump', 'quick_step']);
  });
});

describe('fx-slots (traits, slot resources with thresholds, loadout constraint)', () => {
  const c = build('fx-slots');
  let pc: State;
  beforeAll(async () => {
    pc = ok(await runCreation(c, { traits: { traits: { agility: 2, strength: 1, finesse: 0 } } }));
  });

  test('thresholds decide how many slots a hit marks', async () => {
    const v = createView(c, pc);
    expect(v.eval('[@evasion, @minor, @major]')).toEqual([12, 7, 13]);
    const hp = async (damage: number) => createView(c, ok(await runAction(c, pc, 'take_hit', { answers: [{ damage }] }))).eval('@res.hp.current');
    expect([await hp(3), await hp(7), await hp(13)]).toEqual([5, 4, 3]);
  });

  test('cards: chooser skips owned cards, loadout limit rejects the third, in-loadout cards apply', async () => {
    const one = ok(await runAction(c, pc, 'add_card', { answers: [['parry']] }));
    expect(createView(c, one).root('evasion')).toBe(13);
    let offered: string[] = [];
    const two = ok(await runAction(c, one, 'add_card', { prompt: async (r) => { if (r.kind === 'choose') offered = r.options; return ['whirl']; } }));
    expect(offered).toEqual(['whirl', 'mend']);
    expect(await runAction(c, two, 'add_card', { answers: [['mend']] })).toEqual({ ok: false, rejected: 'Your loadout holds at most 2 cards.' });
  });
});
