// Converts the 2014 SRD (the 5e-bits 5e-database, pinned below) into packs/dnd5e-2014/content and the per-class
// level tables, then merges the hand-written rules in ./overrides on top. The model and ui/ are hand-written.
// Run from the repo root: npm run pack:srd2014
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const COMMIT = 'a6212beb4b278917c2cff41c2b04c4ef4f3e0d6f';
const ROOT = process.cwd();
const CACHE = join(ROOT, 'node_modules/.cache/srd5e-2014', COMMIT);
const PACK = join(ROOT, 'packs/dnd5e-2014');
const OVERRIDES = join(ROOT, 'tools/srd5e-2014/overrides');

type Json = Record<string, unknown>;
type Ref = { index: string; name: string };
type Src = Json & { index: string; name: string };

async function source(name: string): Promise<Src[]> {
  const file = join(CACHE, `${name}.json`);
  if (!existsSync(file)) {
    const res = await fetch(`https://raw.githubusercontent.com/5e-bits/5e-database/${COMMIT}/src/2014/en/5e-SRD-${name}.json`);
    if (!res.ok) throw new Error(`fetching ${name}: ${res.status}`);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, await res.text());
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Src[];
}

/** SRD indexes are kebab-case; pack ids are snake_case. */
const id = (index: string) => index.replace(/-/g, '_');
const prose = (desc: unknown) => (Array.isArray(desc) ? (desc as string[]).join('\n\n') : typeof desc === 'string' ? desc : undefined);
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

function write(rel: string, value: unknown) {
  const file = join(PACK, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------- overrides: JSON merge patch by id. Arrays of {id} items merge by id; other arrays of objects
// (modifiers, effects) are appended, because overrides add rules to what the SRD data gives, never remove them.
function merge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) {
    if (!Array.isArray(base)) return patch;
    const objects = (a: unknown[]) => a.every((p) => p && typeof p === 'object' && !Array.isArray(p));
    if (!objects(patch)) return patch;
    if (!patch.every((p) => 'id' in (p as Json))) return objects(base) ? [...base, ...patch] : patch;
    const out = [...base] as Json[];
    for (const p of patch as Json[]) {
      const i = out.findIndex((b) => b?.id === p.id);
      if (i >= 0) out[i] = merge(out[i], p) as Json;
      else out.push(p);
    }
    return out;
  }
  if (patch && typeof patch === 'object') {
    const out: Json = base && typeof base === 'object' && !Array.isArray(base) ? { ...(base as Json) } : {};
    for (const [k, v] of Object.entries(patch as Json)) {
      if (v === null) delete out[k];
      else out[k] = merge(out[k], v);
    }
    return out;
  }
  return patch;
}

/** overrides/<type>.json: `{ "<entity id>": <merge patch>, … }`; an id the SRD lacks adds a new entity */
function applyOverrides(type: string, entities: Json[]): Json[] {
  const file = join(OVERRIDES, `${type}.json`);
  if (!existsSync(file)) return entities;
  const patches = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Json>;
  const out = entities.map((e) => (patches[e.id as string] ? (merge(e, patches[e.id as string]) as Json) : e));
  for (const [key, patch] of Object.entries(patches)) if (!out.some((e) => e.id === key)) out.push({ id: key, ...patch });
  return out;
}

// ---------- the conversion ----------
const SUBCLASS: Record<string, [number, string]> = {
  barbarian: [3, 'Primal Path'], bard: [3, 'Bard College'], cleric: [1, 'Divine Domain'], druid: [2, 'Druid Circle'],
  fighter: [3, 'Martial Archetype'], monk: [3, 'Monastic Tradition'], paladin: [3, 'Sacred Oath'], ranger: [3, 'Ranger Archetype'],
  rogue: [3, 'Roguish Archetype'], sorcerer: [1, 'Sorcerous Origin'], warlock: [1, 'Otherworldly Patron'], wizard: [2, 'Arcane Tradition'],
};
const CASTER: Record<string, 'full' | 'half' | 'pact'> = { bard: 'full', cleric: 'full', druid: 'full', sorcerer: 'full', wizard: 'full', paladin: 'half', ranger: 'half', warlock: 'pact' };
const PREPARES = new Set(['cleric', 'druid', 'paladin', 'wizard']);
const LEARNS = new Set(['bard', 'ranger', 'sorcerer', 'warlock', 'wizard']);
/** features listed flat in the source that a character picks a few of; `column` in the class table says how many */
const PICKED = [
  { class: 'warlock', prefix: 'Eldritch Invocation: ', group: 'eldritch_invocations', column: 'invocations_known', label: 'eldritch invocation' },
  { class: 'sorcerer', prefix: 'Metamagic: ', group: 'metamagic', column: 'metamagic_known', label: 'metamagic option' },
];

async function main() {
  const [skills, conditions, races, subraces, traits, backgrounds, feats, spells, equipment, magicItems, classes, subclasses, features, levels, proficiencies] =
    await Promise.all(['Skills', 'Conditions', 'Races', 'Subraces', 'Traits', 'Backgrounds', 'Feats', 'Spells', 'Equipment', 'Magic-Items', 'Classes', 'Subclasses', 'Features', 'Levels', 'Proficiencies'].map(source));

  for (const dir of ['content', 'model/tables']) rmSync(join(PACK, dir), { recursive: true, force: true });
  write('model/tables/point_buy.json', [{ id: 'point_buy', key: 'score', rows: [[8, 0], [9, 1], [10, 2], [11, 3], [12, 4], [13, 5], [14, 7], [15, 9]].map(([score, cost]) => ({ score, cost })) }]);
  write('model/tables/abilities.json', [{ id: 'abilities', key: 'id', rows: ABILITIES.map((a, i) => ({ id: a, abbr: a.toUpperCase(), name: ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'][i] })) }]);

  const skillOf = (profIndex: string) => (profIndex.startsWith('skill-') ? id(profIndex.slice(6)) : null);

  // skills, conditions (exhaustion is a number on the character, not a condition), feats
  write('content/skill/all.json', applyOverrides('skill', skills.map((s) => ({ id: id(s.index), name: s.name, description: prose(s.desc), data: { ability: (s.ability_score as Ref).index } }))));
  write('content/condition/all.json', applyOverrides('condition', conditions.filter((c) => c.index !== 'exhaustion').map((c) => ({ id: id(c.index), name: c.name, description: prose(c.desc) }))));
  write('content/feat/all.json', applyOverrides('feat', feats.map((f) => ({ id: id(f.index), name: f.name, description: prose(f.desc) }))));

  // feature choices (fighting styles, hunter's prey…) become options; their parents ask for them on level-up
  const optionParents = new Map<string, string[]>();
  for (const f of features) {
    const opts = ((f.feature_specific as Json | null)?.subfeature_options as Json | undefined)?.from as { options?: { item: Ref }[] } | undefined;
    for (const o of opts?.options ?? []) optionParents.set(o.item.index, [...(optionParents.get(o.item.index) ?? []), id(f.index)]);
  }
  const traitOptionParents = new Map<string, string[]>();
  for (const t of traits) {
    const opts = ((t.trait_specific as Json | null)?.subtrait_options as Json | undefined)?.from as { options?: { item: Ref }[] } | undefined;
    for (const o of opts?.options ?? []) traitOptionParents.set(o.item.index, [...(traitOptionParents.get(o.item.index) ?? []), id(t.index)]);
  }
  // features the source lists flat but a character picks some of as they level (invocations, metamagic)
  for (const f of features) {
    const picked = PICKED.find((x) => f.name.startsWith(x.prefix));
    if (picked && (f.class as Ref).index === picked.class) optionParents.set(f.index, [picked.group]);
  }
  const minLevel = (f: Src) => ((f.prerequisites as { type: string; level?: number }[] | undefined) ?? []).find((x) => x.type === 'level')?.level ?? (f.level as number);
  const options = [
    ...features.filter((f) => optionParents.has(f.index)).map((f) => ({
      id: id(f.index), name: f.name, description: prose(f.desc),
      data: { groups: optionParents.get(f.index), ...(PICKED.some((x) => f.name.startsWith(x.prefix)) ? { min_level: minLevel(f) } : {}) },
    })),
    ...traits.filter((t) => traitOptionParents.has(t.index)).map((t) => ({ id: id(t.index), name: t.name, description: prose(t.desc), data: { groups: traitOptionParents.get(t.index) } })),
  ];
  write('content/option/all.json', applyOverrides('option', options));

  // races and subraces: ability bonuses are modifiers; traits are features; choices run from the `create` hook
  const traitById = new Map(traits.map((t) => [t.index, t]));
  const traitFeatures = (refs: Ref[]) => refs.filter((r) => !traitOptionParents.has(r.index)).map((r) => ({ id: id(r.index), name: r.name, description: prose(traitById.get(r.index)?.desc) }));
  const bonusMods = (bonuses: { ability_score: Ref; bonus: number }[]) => bonuses.map((b) => ({ target: `abilities.${b.ability_score.index}`, op: 'add', value: b.bonus }));
  /** what picking a race (or subrace) asks and grants: skill proficiencies, skill choices, cantrips, option traits */
  const traitCreate = (refs: Ref[]): Json[] => refs.flatMap((ref): Json[] => {
    const t = traitById.get(ref.index);
    if (!t) return [];
    const out: Json[] = [];
    for (const p of (t.proficiencies as Ref[]) ?? []) if (skillOf(p.index)) out.push({ op: 'if', when: `!has(@prof.skills, '${skillOf(p.index)}')`, then: [{ op: 'push', path: 'prof.skills', value: `'${skillOf(p.index)}'` }] });
    const pc = t.proficiency_choices as { choose: number; from: { options: { item?: Ref }[] } } | undefined;
    if (pc && pc.from.options.every((o) => o.item && skillOf(o.item.index))) out.push({ op: 'choose', from: { entity_type: 'skill', filter: '!has(@prof.skills, $v.id)' }, count: pc.choose, into: 'prof.skills', title: t.name });
    const spells = (t.trait_specific as { spell_options?: { choose: number; from: { options: { item: Ref }[] } } } | null)?.spell_options;
    if (spells) {
      const ids = spells.from.options.map((o) => `'${id(o.item.index)}'`).join(', ');
      out.push({ op: 'choose', from: { entity_type: 'spell', filter: `has([${ids}], $v.id) && !has(@spells, $v.id)` }, count: spells.choose, into: 'spells', title: t.name });
    }
    if (traitOptionParents.size && [...traitOptionParents.values()].some((ps) => ps.includes(id(ref.index)))) {
      out.push({ op: 'choose', from: { entity_type: 'option', filter: `has($v.data.groups, '${id(ref.index)}') && ($v.data.prereq ?? true)` }, count: 1, into: 'options', title: t.name, then: gainHooks(1) });
    }
    return out;
  });
  // a picked option (or feat) may grant more through its `gain` hook; effects can't loop, so one guarded call per pick
  const gainHooks = (n: number): Json[] => Array.from({ length: n }, (_, i) => ({ op: 'if', when: `len($choice) > ${i}`, then: [{ op: 'run_hook', entity: `$choice[${i}]`, hook: 'gain', key: "'any'" }] }));
  // `+2 CON, +1 WIS`: what a chooser needs to compare races at a glance
  const bonusText = (bs: { ability_score: Ref; bonus: number }[] = []) => bs.map((b) => `+${b.bonus} ${b.ability_score.name}`).join(', ');
  write('content/race/all.json', applyOverrides('race', races.map((r) => {
    const create: Json[] = [];
    for (const p of (r.starting_proficiencies as Ref[]) ?? []) if (skillOf(p.index)) create.push({ op: 'if', when: `!has(@prof.skills, '${skillOf(p.index)}')`, then: [{ op: 'push', path: 'prof.skills', value: `'${skillOf(p.index)}'` }] });
    create.push(...traitCreate(r.traits as Ref[]));
    const abilityOptions = (r.ability_bonus_options as { choose: number; from: { options: { ability_score: Ref }[] } } | undefined);
    const modifiers = bonusMods(r.ability_bonuses as { ability_score: Ref; bonus: number }[]);
    if (abilityOptions) {
      // e.g. Half-Elf: +1 to two abilities of the player's choice, kept as a choice rather than baked into the scores
      for (const o of abilityOptions.from.options) modifiers.push({ target: `abilities.${o.ability_score.index}`, op: 'add', value: 1, when: `has(@race_abilities, '${o.ability_score.index}')` } as never);
      create.push({ op: 'open_modal', modal: 'race_abilities', with: { count: abilityOptions.choose, exclude: `[${ABILITIES.filter((a) => !abilityOptions.from.options.some((o) => o.ability_score.index === a)).map((a) => `'${a}'`).join(', ')}]` } });
    }
    return {
      id: id(r.index), name: r.name,
      summary: [bonusText(r.ability_bonuses as never), abilityOptions ? `+1 to ${abilityOptions.choose} others` : '', `${r.speed as number} ft`].filter(Boolean).join(' · '),
      description: [prose(r.age), prose(r.alignment), prose(r.size_description), prose(r.language_desc)].filter(Boolean).join('\n\n'),
      data: { speed: r.speed, size: r.size, languages: prose(r.language_desc) },
      modifiers,
      features: traitFeatures(r.traits as Ref[]),
      hooks: create.length ? { create: { any: create } } : undefined,
    };
  })));
  write('content/subrace/all.json', applyOverrides('subrace', subraces.map((s) => {
    const create = traitCreate(s.racial_traits as Ref[]);
    return {
      id: id(s.index), name: s.name, summary: bonusText(s.ability_bonuses as never) || undefined, description: prose(s.desc),
      data: { race: id((s.race as Ref).index) },
      modifiers: bonusMods(s.ability_bonuses as { ability_score: Ref; bonus: number }[]),
      features: traitFeatures(s.racial_traits as Ref[]),
      hooks: create.length ? { create: { any: create } } : undefined,
    };
  })));

  write('content/background/all.json', applyOverrides('background', backgrounds.map((b) => {
    const feature = b.feature as { name: string; desc: string[] };
    return {
      id: id(b.index), name: b.name,
      data: { skills: (b.starting_proficiencies as Ref[]).map((p) => skillOf(p.index)).filter(Boolean) },
      features: [{ id: `${id(b.index)}_feature`, name: feature.name, description: prose(feature.desc) }],
    };
  })));

  // spells, one file per level
  const spellEntities = spells.map((s) => {
    const damage = s.damage as { damage_type?: Ref; damage_at_slot_level?: Record<string, string>; damage_at_character_level?: Record<string, string> } | undefined;
    const dice = damage ? Object.values(damage.damage_at_slot_level ?? damage.damage_at_character_level ?? {})[0] : undefined;
    const material = s.material ? ` (${s.material as string})` : '';
    return {
      id: id(s.index), name: s.name,
      description: [prose(s.desc), s.higher_level && (s.higher_level as string[]).length ? `**At Higher Levels.** ${prose(s.higher_level)}` : ''].filter(Boolean).join('\n\n'),
      data: {
        level: s.level, school: (s.school as Ref).index, classes: (s.classes as Ref[]).map((c) => id(c.index)),
        casting_time: s.casting_time, range: s.range, components: `${(s.components as string[]).join(', ')}${material}`, duration: s.duration,
        concentration: s.concentration, ritual: s.ritual,
        ...(dice ? { damage: `${dice}${damage?.damage_type ? ` ${damage.damage_type.name.toLowerCase()}` : ''}` } : {}),
        ...(s.dc ? { save: ((s.dc as Json).dc_type as Ref).index } : {}),
        ...(s.attack_type ? { attack: s.attack_type } : {}),
      },
    };
  });
  const allSpells = applyOverrides('spell', spellEntities);
  for (let lvl = 0; lvl <= 9; lvl++) write(`content/spell/level-${lvl}.json`, allSpells.filter((s) => (s.data as Json).level === lvl));

  // items: mundane equipment by kind, then magic items
  const kindOf = (e: Src): string => {
    const cat = (e.equipment_category as Ref).index;
    if (cat === 'weapon') return 'weapon';
    if (cat === 'armor') return e.armor_category === 'Shield' ? 'shield' : 'armor';
    if (cat === 'tools') return 'tool';
    if (cat === 'mounts-and-vehicles') return (e.vehicle_category ? 'vehicle' : 'mount');
    const gear = (e.gear_category as Ref | undefined)?.index;
    if (gear === 'equipment-packs') return 'pack';
    if (gear === 'ammunition') return 'ammunition';
    return 'gear';
  };
  const items = equipment.map((e) => {
    const kind = kindOf(e);
    const cost = e.cost as { quantity: number; unit: string } | undefined;
    const data: Json = { kind, category: (e.category_range ?? e.armor_category ?? (e.gear_category as Ref | undefined)?.name ?? (e.equipment_category as Ref).name) as string, ...(cost ? { cost: `${cost.quantity} ${cost.unit}` } : {}), ...(typeof e.weight === 'number' ? { weight: e.weight } : {}) };
    const modifiers: Json[] = [];
    if (kind === 'weapon') {
      const dmg = e.damage as { damage_dice: string; damage_type: Ref } | undefined;
      const props = ((e.properties as Ref[]) ?? []).map((p) => p.name);
      const range = e.range as { normal: number; long?: number } | undefined;
      Object.assign(data, {
        ...(dmg ? { damage: dmg.damage_dice, damage_type: dmg.damage_type.name.toLowerCase() } : {}),
        ...(e.two_handed_damage ? { versatile: (e.two_handed_damage as { damage_dice: string }).damage_dice } : {}),
        properties: props,
        finesse: props.includes('Finesse'),
        ranged: e.weapon_range === 'Ranged',
        ...(range ? { range: range.long ? `${range.normal}/${range.long} ft` : `${range.normal} ft` } : {}),
      });
    }
    if (kind === 'armor' || kind === 'shield') {
      const ac = e.armor_class as { base: number; dex_bonus: boolean; max_bonus?: number };
      Object.assign(data, { ac_base: ac.base, ...(ac.dex_bonus ? (ac.max_bonus ? { dex_cap: ac.max_bonus } : {}) : { dex_cap: 0 }), str_min: e.str_minimum ?? 0, stealth_disadv: !!e.stealth_disadvantage });
      // armour sets AC while equipped (the inventory field only owns equipped items); a shield adds to it
      if (kind === 'shield') modifiers.push({ target: 'ac', op: 'add', value: ac.base });
      else modifiers.push({ target: 'ac', op: 'set', value: ac.dex_bonus ? (ac.max_bonus ? `${ac.base} + min(@mods.dex, ${ac.max_bonus})` : `${ac.base} + @mods.dex`) : ac.base });
    }
    const contents = (e.contents as { item: Ref; quantity: number }[] | undefined)?.map((c) => `${c.quantity} × ${c.item.name}`);
    return {
      id: id(e.index), name: e.name,
      description: [prose(e.desc), contents?.length ? `**Contains:** ${contents.join(', ')}` : ''].filter(Boolean).join('\n\n') || undefined,
      data, ...(modifiers.length ? { modifiers } : {}),
    };
  });
  // magic items: a variant (Belt of Hill Giant Strength) replaces its generic parent (Belt of Giant Strength). Armor/Weapon
  // +N become one item per mundane base so they keep its AC, damage and properties; 5e-bits lacks the SRD's Shield, +N.
  const enchanted = (kind: string, n: number, rarity: string, description: string) => items.filter((i) => i.data.kind === kind).map((i) => ({
    id: `${i.id}_${n}`, name: `${i.name}, +${n}`, description,
    data: { ...i.data, cost: undefined, rarity, attunement: false, ...(kind === 'weapon' ? { attack_bonus: n, damage_bonus: n } : {}) },
    ...(kind === 'weapon' ? {} : { modifiers: [...(i.modifiers ?? []), { target: 'ac', op: 'add', value: n }] }),
  }));
  const magic = magicItems.filter((m) => !(Array.isArray(m.variants) && m.variants.length)).flatMap((m): Json[] => {
    const desc = prose(m.desc) ?? '';
    const rarity = (m.rarity as { name: string }).name;
    const plus = /^(armor|weapon)-(\d)$/.exec(m.index);
    if (plus) return enchanted(plus[1], Number(plus[2]), rarity, desc);
    return [{ id: id(m.index), name: m.name, description: desc, data: { kind: 'magic', category: (m.equipment_category as Ref).name, rarity, attunement: /requires attunement/i.test(desc) } }];
  });
  for (const [n, rarity] of ['Uncommon', 'Rare', 'Very Rare'].entries()) {
    magic.push(...enchanted('shield', n + 1, rarity, `Armor (shield), ${rarity.toLowerCase()}\n\nWhile holding this shield, you have a +${n + 1} bonus to AC. This bonus is in addition to the shield's normal bonus to AC.`));
  }
  // entity ids are unique across types (docs/gaps.md #7): an item named like a spell (Shield) gets a suffix
  const taken = new Set([skills, conditions, feats, races, subraces, backgrounds, spells, classes, subclasses].flat().map((x) => id(x.index)));
  for (const o of options) taken.add(o.id);
  const allItems = applyOverrides('item', [...items, ...magic].map((i) => (taken.has(String(i.id)) ? { ...i, id: `${String(i.id)}_item` } : i)));
  for (const kind of ['weapon', 'armor', 'gear', 'tool', 'pack', 'ammunition', 'mount', 'magic']) {
    const of = allItems.filter((i) => ((i.data as Json).kind === kind) || (kind === 'armor' && (i.data as Json).kind === 'shield') || (kind === 'mount' && (i.data as Json).kind === 'vehicle'));
    if (of.length) write(`content/item/${kind}.json`, of);
  }

  // classes: data, features gated by class level, level-up choices as on_level hooks, and a level table each
  const profName = new Map(proficiencies.map((p) => [p.index, p]));
  const classesOut: Json[] = [];
  const classTables: Json[] = [];
  const subclassEntities: Json[] = [];
  for (const c of classes) {
    const cid = id(c.index);
    const rows = levels.filter((l) => (l.class as Ref).index === c.index && !l.subclass).sort((a, b) => (a.level as number) - (b.level as number));
    const table = rows.map((l) => {
      const sc = (l.spellcasting ?? {}) as Record<string, number>;
      const row: Json = { level: l.level, cantrips_known: sc.cantrips_known ?? 0, ...(sc.spells_known !== undefined ? { spells_known: sc.spells_known } : {}) };
      const slots = Array.from({ length: 9 }, (_, i) => sc[`spell_slots_level_${i + 1}`] ?? 0);
      if (CASTER[c.index] === 'pact') {
        // warlock slots are pact slots: all of one level, back on a short rest
        const lvl = slots.reduce((hi, n, i) => (n > 0 ? i + 1 : hi), 0);
        Object.assign(row, { pact_slots: lvl ? slots[lvl - 1] : 0, pact_level: lvl });
        slots.fill(0);
      }
      slots.forEach((n, i) => { row[`slot_${i + 1}`] = n; });
      for (const [k, v] of Object.entries((l.class_specific ?? {}) as Json)) {
        if (typeof v === 'number') row[k] = v;
        else if (v && typeof v === 'object' && 'dice_count' in v) row[k] = `${(v as Json).dice_count}d${(v as Json).dice_value}`;
      }
      return row;
    });
    if (c.index === 'wizard') table.forEach((r) => { r.spells_known = 6 + 2 * ((r.level as number) - 1); });
    classTables.push({ id: cid, key: 'level', rows: table });

    const [subclassLevel, subclassLabel] = SUBCLASS[c.index];
    const own = features.filter((f) => (f.class as Ref).index === c.index && !f.subclass && !optionParents.has(f.index));
    const isAsi = (f: Src) => /ability score improvement/i.test(f.name);
    const choice = (f: Src, into: string): Json[] => {
      const fs = (f.feature_specific ?? {}) as Json;
      if (fs.subfeature_options) {
        const n = (fs.subfeature_options as { choose: number }).choose;
        return [{ op: 'choose', from: { entity_type: 'option', filter: `has($v.data.groups, '${id(f.index)}') && !has(@options, $v.id) && ($v.data.prereq ?? true)` }, count: n, into, title: f.name, then: gainHooks(n) }];
      }
      if (fs.expertise_options) {
        const n = (fs.expertise_options as { choose: number }).choose;
        return [{ op: 'choose', from: { entity_type: 'skill', filter: 'has(@prof.skills, $v.id) && !has(@prof.expertise, $v.id)' }, count: n, into: 'prof.expertise', title: 'Expertise' }];
      }
      return [];
    };
    const hooks: Record<string, Json[]> = {};
    const at = (lvl: number) => (hooks[String(lvl)] ??= []);
    const choices = c.proficiency_choices as { choose: number; from: { options: { item?: Ref }[] } }[];
    const skillChoice = choices.find((pc) => pc.from.options.some((o) => o.item && skillOf(o.item.index)));
    const skillIds = (skillChoice?.from.options ?? []).map((o) => (o.item ? skillOf(o.item.index) : null)).filter(Boolean) as string[];
    if (skillChoice) at(1).push({ op: 'choose', from: { entity_type: 'skill', filter: 'has($self.data.skill_choices, $v.id) && !has(@prof.skills, $v.id)' }, count: skillChoice.choose, into: 'prof.skills', title: `Choose ${skillChoice.choose} skills` });
    for (const f of own) {
      const lvl = f.level as number;
      if (isAsi(f)) at(lvl).push({ op: 'open_modal', modal: 'asi' });
      else at(lvl).push(...choice(f, 'options'));
    }
    at(subclassLevel).push({ op: 'choose', from: { entity_type: 'subclass', filter: '$v.data.class == $self.id' }, count: 1, into: 'subclasses', title: `Choose a ${subclassLabel.toLowerCase()}`,
      then: [{ op: 'run_hook', entity: '$choice[0]', hook: 'on_level', key: subclassLevel }] });
    // spells learned at each level: new cantrips, and new known spells for classes that keep a list
    for (let i = 0; i < table.length; i++) {
      const lvl = i + 1;
      const prev = i ? table[i - 1] : { cantrips_known: 0, spells_known: 0 };
      const newCantrips = (table[i].cantrips_known as number) - (prev.cantrips_known as number);
      if (newCantrips > 0) at(lvl).push({ op: 'choose', from: { entity_type: 'spell', filter: '$v.data.level == 0 && has($v.data.classes, $self.id) && !has(@spells, $v.id)' }, count: newCantrips, into: 'spells', title: `Learn ${newCantrips === 1 ? 'a cantrip' : `${newCantrips} cantrips`}` });
      const known = table[i].spells_known as number | undefined;
      const newSpells = known === undefined ? 0 : known - ((prev.spells_known as number | undefined) ?? 0);
      if (LEARNS.has(c.index) && newSpells > 0) at(lvl).push({ op: 'choose', from: { entity_type: 'spell', filter: '$v.data.level >= 1 && $v.data.level <= @max_spell_level && has($v.data.classes, $self.id) && !has(@spells, $v.id)' }, count: newSpells, into: 'spells', title: `Learn ${newSpells === 1 ? 'a spell' : `${newSpells} spells`}` });
      for (const picked of PICKED.filter((x) => x.class === c.index)) {
        const now = (table[i][picked.column] as number | undefined) ?? 0;
        const before = i ? ((table[i - 1][picked.column] as number | undefined) ?? 0) : 0;
        if (now > before) at(lvl).push({ op: 'choose', from: { entity_type: 'option', filter: `has($v.data.groups, '${picked.group}') && ($v.data.min_level ?? 0) <= @class_level && !has(@options, $v.id) && ($v.data.prereq ?? true)` }, count: now - before, into: 'options', title: now - before === 1 ? `Choose an ${picked.label}` : `Choose ${now - before} × ${picked.label}`, then: gainHooks(now - before) });
      }
    }
    const profs = (c.proficiencies as Ref[]).map((p) => p.index);
    const names = (type: string) => profs.map((p) => profName.get(p)).filter((p) => p && (p.type as string) === type).map((p) => p!.name).join(', ');
    const spellcasting = c.spellcasting as { spellcasting_ability?: Ref } | undefined;
    classesOut.push({
      id: cid, name: c.name,
      summary: `d${c.hit_die as number} hit die · ${(c.saving_throws as Ref[]).map((s) => s.name).join(', ')} saves`,
      description: `Hit die d${c.hit_die as number}. Saving throws: ${(c.saving_throws as Ref[]).map((s) => s.name).join(', ')}.`,
      data: {
        hit_die: c.hit_die, saves: (c.saving_throws as Ref[]).map((s) => s.index), skill_choices: skillIds, skill_count: skillChoice?.choose ?? 0,
        armor: names('Armor'), weapons: names('Weapons'), tools: names("Artisan's Tools") || names('Other Tools') || names('Musical Instruments'),
        caster: CASTER[c.index] ?? 'none', ...(spellcasting?.spellcasting_ability ? { cast_ability: spellcasting.spellcasting_ability.index } : {}),
        prepares: PREPARES.has(c.index), learns: LEARNS.has(c.index),
        subclass_level: subclassLevel, subclass_label: subclassLabel,
      },
      features: own.filter((f) => !isAsi(f)).map((f) => ({ id: id(f.index), name: f.name, when: `$owner.level >= ${f.level as number}`, description: prose(f.desc) })),
      hooks: { on_level: hooks },
    });

    for (const s of subclasses.filter((sc) => (sc.class as Ref).index === c.index)) {
      const sid = id(s.index);
      const sf = features.filter((f) => (f.subclass as Ref | null)?.index === s.index && !optionParents.has(f.index));
      const shooks: Record<string, Json[]> = {};
      for (const f of sf) {
        const opts = choice(f, 'options');
        if (opts.length) (shooks[String(f.level)] ??= []).push(...opts);
      }
      subclassEntities.push({
        id: sid, name: s.name, summary: s.subclass_flavor as string, description: prose(s.desc),
        data: { class: cid },
        features: sf.map((f) => ({ id: id(f.index), name: f.name, when: `(@classes[$self.data.class].level ?? 0) >= ${f.level as number}`, description: prose(f.desc) })),
        ...(Object.keys(shooks).length ? { hooks: { on_level: shooks } } : {}),
      });
    }
  }
  write('content/class/all.json', applyOverrides('class', classesOut));
  write('content/subclass/all.json', applyOverrides('subclass', subclassEntities));
  for (const t of classTables) write(`model/tables/${t.id as string}.json`, [t]);

  const count = (dir: string) => readdirSync(join(PACK, dir)).reduce((n, f) => n + (JSON.parse(readFileSync(join(PACK, dir, f), 'utf8')) as unknown[]).length, 0);
  console.log(Object.fromEntries(readdirSync(join(PACK, 'content')).map((t) => [t, count(join('content', t))])));
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
