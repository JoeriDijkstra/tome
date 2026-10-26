// Pack format, schema_version 1. See docs/SPEC.md → Content packs.
import { z } from 'zod';

export const SUPPORTED_SCHEMA_VERSIONS = [1];

export const ID = /^[a-z][a-z0-9_]{0,63}$/;
const Id = z.string().regex(ID, 'ids are lowercase letters, digits and _, starting with a letter');
const PackId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
/** A formula position: strings are formulas, numbers/booleans/null are literals. */
const F = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FormulaSrc = z.infer<typeof F>;

export const Manifest = z
  .strictObject({
    id: PackId,
    name: z.string().min(1),
    kind: z.enum(['major', 'expansion']),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'version must be semver'),
    schema_version: z.int().positive(),
    author: z.string().optional(),
    description: z.string().optional(),
    license: z.strictObject({ name: z.string(), attribution: z.string().optional(), url: z.string().optional() }).optional(),
    icon: z.string().optional(),
    extends: z.strictObject({ id: PackId, range: z.string() }).optional(),
  })
  .refine((m) => (m.kind === 'expansion') === (m.extends !== undefined), {
    message: 'an expansion needs "extends"; a major pack must not have it',
    path: ['extends'],
  });
export type Manifest = z.infer<typeof Manifest>;

export const FIELD_TYPES = ['string', 'text', 'number', 'boolean', 'select', 'ref', 'list', 'map', 'object', 'formula'] as const;

export interface FieldDef {
  key: string;
  type: (typeof FIELD_TYPES)[number];
  label?: string;
  default?: unknown;
  min?: number;
  max?: number;
  options?: string[];
  entity_type?: string;
  key_entity_type?: string;
  of?: (typeof FIELD_TYPES)[number];
  fields?: FieldDef[];
  owns_when?: FormulaSrc;
  owns?: boolean;
}

export const FieldDef: z.ZodType<FieldDef> = z.lazy(() =>
  z.strictObject({
    key: Id,
    type: z.enum(FIELD_TYPES),
    label: z.string().optional(),
    default: z.unknown().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    options: z.array(z.string()).optional(),
    entity_type: Id.optional(),
    key_entity_type: Id.optional(),
    of: z.enum(FIELD_TYPES).optional(),
    fields: z.array(FieldDef).optional(),
    owns_when: F.optional(),
    owns: z.boolean().optional(),
  }),
);

export type Effect =
  | { op: 'set'; path: string; value: FormulaSrc }
  | { op: 'add'; path: string; value: FormulaSrc; min?: FormulaSrc; max?: FormulaSrc }
  | { op: 'push'; path: string; value: FormulaSrc }
  | { op: 'remove'; path: string; where: FormulaSrc }
  | { op: 'toggle'; path: string; value?: FormulaSrc }
  | { op: 'choose'; from: { entity_type: string; filter?: FormulaSrc }; count: FormulaSrc; into?: string; title?: string; then?: Effect[] }
  | { op: 'open_modal'; modal: string; with?: Record<string, FormulaSrc> }
  | { op: 'run_hook'; entity: FormulaSrc; hook: string; key: FormulaSrc }
  | { op: 'reset'; tag: string }
  | { op: 'if'; when: FormulaSrc; then: Effect[]; else?: Effect[] };

const Effects: z.ZodType<Effect[]> = z.lazy(() => z.array(Effect));
export const Effect: z.ZodType<Effect> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('set'), path: z.string(), value: F }),
    z.strictObject({ op: z.literal('add'), path: z.string(), value: F, min: F.optional(), max: F.optional() }),
    z.strictObject({ op: z.literal('push'), path: z.string(), value: F }),
    z.strictObject({ op: z.literal('remove'), path: z.string(), where: F }),
    z.strictObject({ op: z.literal('toggle'), path: z.string(), value: F.optional() }),
    z.strictObject({
      op: z.literal('choose'),
      from: z.strictObject({ entity_type: Id, filter: F.optional() }),
      count: F,
      into: z.string().optional(),
      title: z.string().optional(),
      then: Effects.optional(),
    }),
    z.strictObject({ op: z.literal('open_modal'), modal: Id, with: z.record(z.string(), F).optional() }),
    z.strictObject({ op: z.literal('run_hook'), entity: F, hook: Id, key: F }),
    z.strictObject({ op: z.literal('reset'), tag: Id }),
    z.strictObject({ op: z.literal('if'), when: F, then: Effects, else: Effects.optional() }),
  ]),
);

export const Modifier = z.strictObject({
  id: Id.optional(),
  target: z.string(),
  op: z.enum(['set', 'add', 'max', 'min']),
  value: F,
  when: F.optional(),
  type: Id.optional(),
});
export type Modifier = z.infer<typeof Modifier>;

export const ResourceDef = z.strictObject({
  id: Id,
  label: z.string(),
  max: F,
  reset: z.array(Id).optional(),
  temp: z.boolean().optional(),
});
export type ResourceDef = z.infer<typeof ResourceDef>;

export const Grant = z.strictObject({ entity: Id, when: F.optional() });
export type Grant = z.infer<typeof Grant>;

export const Feature = z.strictObject({
  id: Id,
  name: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  when: F.optional(),
  resource: Id.optional(),
  actions: z.array(Id).optional(),
  modifiers: z.array(Modifier).optional(),
  resources: z.array(ResourceDef).optional(),
  grants: z.array(Grant).optional(),
});
export type Feature = z.infer<typeof Feature>;

export const Entity = z.strictObject({
  id: Id,
  name: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  modifiers: z.array(Modifier).optional(),
  features: z.array(Feature).optional(),
  resources: z.array(ResourceDef).optional(),
  grants: z.array(Grant).optional(),
  hooks: z.record(Id, z.record(z.string(), Effects)).optional(),
});
export type Entity = z.infer<typeof Entity>;

export const EntityType = z.strictObject({
  id: Id,
  label: z.string(),
  plural: z.string().optional(),
  fields: z.array(FieldDef).default([]),
});
export type EntityType = z.infer<typeof EntityType>;

export const Derived = z
  .strictObject({ id: Id, label: z.string().optional(), formula: F, each: Id.optional(), each_type: Id.optional() })
  .refine((d) => !(d.each && d.each_type), { message: 'use either "each" or "each_type"' });
export type Derived = z.infer<typeof Derived>;

export const ModifierType = z.strictObject({ id: Id, stacking: z.enum(['sum', 'highest']) });
export const Constraint = z.strictObject({ id: Id, violated_when: F, message: z.string() });
export type Constraint = z.infer<typeof Constraint>;
export const TableDef = z.strictObject({ id: Id, key: z.string(), rows: z.array(z.record(z.string(), z.unknown())) });
export const Character = z.strictObject({ fields: z.array(FieldDef) });

// ---------- ui/ ----------
// Text fields (T) are literal text with {formula} templates; formula fields (F) are formulas. See SPEC → Text and formulas.
const T = z.string();
/** a path into the character (write path, or modifier target for `explain`) */
const Path = z.string();

export const Input = z.strictObject({
  key: Id,
  type: z.enum(['number', 'stepper', 'string', 'text', 'boolean', 'select', 'choice', 'allocation', 'assign']),
  label: T.optional(),
  description: T.optional(),
  required: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  default: F.optional(),
  options: z.union([z.array(z.string()), z.string()]).optional(),
  visible_when: F.optional(),
  entity_type: Id.optional(),
  filter: F.optional(),
  // allocation / assign (wizard, M4)
  keys: z.array(Id).optional(),
  values: z.array(z.number()).optional(),
  cost_table: Id.optional(),
  budget: z.number().optional(),
});
export type Input = z.infer<typeof Input>;

export const Action = z
  .strictObject({
    id: Id,
    label: T,
    icon: z.string().optional(),
    style: z.enum(['primary', 'secondary', 'danger', 'plain']).optional(),
    visible_when: F.optional(),
    enabled_when: F.optional(),
    confirm: z.strictObject({ title: T, message: T.optional() }).optional(),
    modal: Id.optional(),
    effects: Effects.optional(),
  })
  .refine((a) => (a.modal === undefined) !== (a.effects === undefined), { message: 'an action needs either "modal" or "effects"' });
export type Action = z.infer<typeof Action>;

export const Modal = z.strictObject({
  id: Id,
  title: T.optional(),
  description: T.optional(),
  fields: z.array(Input).default([]),
  validate: z.array(z.strictObject({ when: F, message: T })).default([]),
  submit: z.strictObject({ label: T.optional(), effects: Effects.default([]) }).optional(),
});
export type Modal = z.infer<typeof Modal>;

const Visible = { visible_when: F.optional() };
const StatItem = z.strictObject({ label: T, value: F, sub: F.optional(), explain: Path.optional(), action: Id.optional(), ...Visible });
export type StatItem = z.infer<typeof StatItem>;
export const Section = z.discriminatedUnion('widget', [
  StatItem.extend({ widget: z.literal('stat') }),
  z.strictObject({ widget: z.literal('stat_grid'), title: T.optional(), columns: z.int().min(1).max(6).optional(), items: z.array(StatItem), ...Visible }),
  z.strictObject({
    widget: z.literal('resource'),
    resource: Id,
    label: T.optional(),
    style: z.enum(['bar', 'pips', 'counter', 'slots']).optional(),
    thresholds: z.array(z.strictObject({ label: T, at: F })).optional(),
    actions: z.array(Id).optional(),
    ...Visible,
  }),
  z.strictObject({
    widget: z.literal('list'),
    source: F,
    title: T.optional(),
    style: z.enum(['rows', 'cards']).optional(),
    row: z.strictObject({ title: T, subtitle: T.optional(), body: T.optional(), actions: z.array(Id).optional() }),
    group_by: F.optional(),
    empty: T.optional(),
    add: Id.optional(),
    ...Visible,
  }),
  z
    .strictObject({
      widget: z.literal('toggles'),
      title: T.optional(),
      items: z.array(z.strictObject({ label: T, path: Path })).optional(),
      path: Path.optional(),
      options: F.optional(),
      label: T.optional(),
      ...Visible,
    })
    .refine((t) => (t.items !== undefined) !== (t.path !== undefined && t.options !== undefined && t.label !== undefined), {
      message: 'toggles need either "items", or "path" + "options" + "label"',
    }),
  z.strictObject({ widget: z.literal('field'), label: T, path: Path, input: z.enum(['string', 'text', 'number']).optional(), ...Visible }),
  z.strictObject({ widget: z.literal('text'), text: T, ...Visible }),
  z.strictObject({ widget: z.literal('actions'), actions: z.array(Id), ...Visible }),
  z.strictObject({ widget: z.literal('notes'), ...Visible }),
]);
export type Section = z.infer<typeof Section>;
export const Tab = z.strictObject({ id: Id, label: T, sections: z.array(Section).default([]) });
export type Tab = z.infer<typeof Tab>;
export const Sheet = z.strictObject({
  header: z.strictObject({ title: T.optional(), subtitle: T.optional(), actions: z.array(Id).optional() }).optional(),
  tabs: z.array(Id).default([]),
});
export type Sheet = z.infer<typeof Sheet>;
export const Step = z.strictObject({
  id: Id,
  title: T.optional(),
  description: T.optional(),
  fields: z.array(Input).default([]),
  effects: Effects.default([]),
  review: z.boolean().optional(),
});
export type Step = z.infer<typeof Step>;
export const Creation = z.strictObject({ steps: z.array(Step) });

export const Patch = z.strictObject({ target: z.string(), merge: z.record(z.string(), z.unknown()) });
export type Patch = z.infer<typeof Patch>;
