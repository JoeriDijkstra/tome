// The engine asks for input through `prompt`; these render those requests as native-style forms.
import { MenuView } from '@expo/ui/community/menu';
import { useState } from 'react';
import { ScrollView, Switch, TextInput, View } from 'react-native';

import { type Answer, type Compiled, type PromptRequest, truthy, type View as SheetView } from '@/engine';
import type { Input } from '@/engine/schema';
import { Group, Icon, IconButton, ModalBar, Row, styles, Txt, usePalette } from '@/ui/kit';

export type Values = Record<string, unknown>;

/** `standard_array` → `Standard array`: select options and assign keys are ids, not prose. */
const humanize = (id: string) => (id.charAt(0).toUpperCase() + id.slice(1)).replaceAll('_', ' ');

/** Starting values: given ones, then each field's `default`; a point buy starts every key at its minimum. */
export function initialValues(fields: Input[], given: Values, view: SheetView): Values {
  const out: Values = { ...given };
  for (const f of fields) {
    if (out[f.key] !== undefined) continue;
    if (f.default !== undefined) out[f.key] = view.eval(f.default, { input: out });
    else if (f.type === 'allocation') out[f.key] = Object.fromEntries((f.keys ?? []).map((k) => [k, f.min ?? 0]));
  }
  return out;
}

/** The visible fields, and whether a required one is still empty. The engine re-checks everything. */
export function visibleFields(fields: Input[], values: Values, view: SheetView) {
  const visible = fields.filter((f) => f.visible_when === undefined || truthy(view.eval(f.visible_when, { input: values })));
  const missing = visible.some((f) => {
    const v = values[f.key];
    if (!f.required) return false;
    if (f.type === 'assign') return (f.keys ?? []).some((k) => typeof (v as Values | undefined)?.[k] !== 'number');
    return v === undefined || v === null || v === '' || (f.type === 'choice' && Array.isArray(v) && v.length < (f.min ?? 1));
  });
  return { visible, missing };
}

export function PromptView({ request, compiled, view, onAnswer }: { request: PromptRequest; compiled: Compiled; view: SheetView; onAnswer: (a: Answer | null) => void }) {
  const p = usePalette();
  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      {request.kind === 'modal' ? (
        <PackModal modalId={request.modal} initial={request.with} compiled={compiled} view={view} onAnswer={onAnswer} />
      ) : (
        <Chooser
          title={request.title ?? `Choose ${request.count === 1 ? 'a' : request.count} ${compiled.entityTypes.get(request.entityType)?.label ?? request.entityType}`}
          options={request.options}
          count={request.count}
          compiled={compiled}
          view={view}
          onDone={(ids) => onAnswer(ids)}
          onCancel={() => onAnswer(null)}
        />
      )}
    </View>
  );
}

/** A pack modal: its inputs, then submit (the engine validates again and runs `submit.effects`). */
function PackModal({ modalId, initial, compiled, view, onAnswer }: { modalId: string; initial: Values; compiled: Compiled; view: SheetView; onAnswer: (a: Answer | null) => void }) {
  const p = usePalette();
  const modal = compiled.modals.get(modalId)!;
  const [values, setValues] = useState<Values>(() => initialValues(modal.fields, initial, view));
  const vars = { input: values };
  const { visible, missing } = visibleFields(modal.fields, values, view);
  const broken = modal.validate.find((r) => truthy(view.eval(r.when, vars)));
  const set = (key: string) => (v: unknown) => setValues((s) => ({ ...s, [key]: v }));
  return (
    <>
      <ModalBar
        title={modal.title ? view.text(modal.title, vars) : ''}
        onCancel={() => onAnswer(null)}
        confirm={{ label: modal.submit?.label ? view.text(modal.submit.label, vars) : 'Done', onPress: () => onAnswer(values), disabled: missing || broken !== undefined }}
      />
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        {modal.description ? <Txt muted style={{ paddingHorizontal: 16 }}>{view.text(modal.description, vars)}</Txt> : null}
        {visible.map((f) => (
          <Field key={f.key} input={f} value={values[f.key]} onChange={set(f.key)} compiled={compiled} view={view} vars={vars} />
        ))}
        {broken ? <Txt color={p.danger} size={15} style={{ paddingHorizontal: 16 }}>{view.text(broken.message, vars)}</Txt> : null}
      </ScrollView>
    </>
  );
}

export function Field({ input, value, onChange, compiled, view, vars }: { input: Input; value: unknown; onChange: (v: unknown) => void; compiled: Compiled; view: SheetView; vars: Values }) {
  const p = usePalette();
  const label = input.label ? view.text(input.label, vars) : input.key;
  const footer = input.description ? view.text(input.description, vars) : undefined;
  const textStyle = { color: p.text, fontSize: 17 };
  switch (input.type) {
    case 'number':
      return (
        <Group footer={footer}>
          <Row title={label} trailing={
            <TextInput accessibilityLabel={label} keyboardType="numbers-and-punctuation" autoFocus placeholder="0" placeholderTextColor={p.secondary}
              value={value === undefined || value === null ? '' : String(value)}
              onChangeText={(t) => onChange(t.trim() === '' ? undefined : Number.isNaN(Number(t)) ? t : Number(t))}
              style={[textStyle, { textAlign: 'right', minWidth: 100, fontVariant: ['tabular-nums'] }]} />
          } />
        </Group>
      );
    case 'stepper': {
      const n = typeof value === 'number' ? value : 0;
      const step = input.step ?? 1;
      return (
        <Group footer={footer}>
          <Row title={label} trailing={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <IconButton name="minus.circle" android="remove_circle_outline" label={`${label} minus`} disabled={input.min !== undefined && n - step < input.min} onPress={() => onChange(n - step)} />
              <Txt weight="600" style={{ minWidth: 28, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{String(n)}</Txt>
              <IconButton name="plus.circle" android="add_circle_outline" label={`${label} plus`} disabled={input.max !== undefined && n + step > input.max} onPress={() => onChange(n + step)} />
            </View>
          } />
        </Group>
      );
    }
    case 'string':
    case 'text':
      return (
        <Group header={label} footer={footer}>
          <Row>
            <TextInput accessibilityLabel={label} value={typeof value === 'string' ? value : ''} onChangeText={onChange} multiline={input.type === 'text'}
              placeholder={label} placeholderTextColor={p.secondary} style={[textStyle, input.type === 'text' && { minHeight: 88 }]} />
          </Row>
        </Group>
      );
    case 'boolean':
      return (
        <Group footer={footer}>
          <Row title={label} trailing={<Switch accessibilityLabel={label} value={value === true} onValueChange={onChange} />} />
        </Group>
      );
    case 'select': {
      const options = typeof input.options === 'string' ? view.eval(input.options, vars) : input.options;
      return (
        <Group header={label} footer={footer}>
          {(Array.isArray(options) ? options : []).map((o) => (
            <Row key={String(o)} title={humanize(String(o))} label={humanize(String(o))} onPress={() => onChange(o)} trailing={value === o ? <Icon name="checkmark" android="check" size={17} /> : undefined} />
          ))}
        </Group>
      );
    }
    case 'choice': {
      const options = (compiled.byType.get(input.entity_type ?? '') ?? [])
        .filter((e) => input.filter === undefined || truthy(view.eval(input.filter, { ...vars, v: e.envelope, k: e.id })))
        .map((e) => e.id);
      return (
        <Group header={label} footer={footer}>
          {choiceRows(options, Array.isArray(value) ? (value as string[]) : [], input.max ?? 1, onChange, compiled, view)}
        </Group>
      );
    }
    case 'assign': {
      const given = (value ?? {}) as Record<string, number | undefined>;
      const pool = input.values ?? [];
      // picking a value another key holds swaps the two, so every value stays used at most once
      const pick = (key: string, n: number) => {
        const next = { ...given, [key]: n };
        const used = (x: number) => Object.values(next).filter((y) => y === x).length;
        const holder = Object.keys(given).find((k) => k !== key && given[k] === n);
        if (holder && used(n) > pool.filter((x) => x === n).length) next[holder] = given[key];
        onChange(Object.fromEntries(Object.entries(next).filter(([, x]) => x !== undefined)));
      };
      return (
        <Group header={label} footer={footer ?? `Use each of ${pool.join(', ')} once.`}>
          {(input.keys ?? []).map((k) => (
            <Row key={k} title={humanize(k)} trailing={
              <MenuView title={humanize(k)} actions={[...new Set(pool)].map((n) => ({ id: String(n), title: String(n), state: given[k] === n ? 'on' as const : undefined }))}
                onPressAction={({ nativeEvent }) => pick(k, Number(nativeEvent.event))}>
                <View accessibilityRole="button" accessibilityLabel={`${humanize(k)} value`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Txt weight="600" color={given[k] === undefined ? p.secondary : p.tint} style={{ fontVariant: ['tabular-nums'] }}>{given[k] === undefined ? 'Choose' : String(given[k])}</Txt>
                  <Icon name="chevron.up.chevron.down" android="unfold_more" size={13} color={p.secondary} />
                </View>
              </MenuView>
            } />
          ))}
        </Group>
      );
    }
    case 'allocation': {
      const scores = (value ?? {}) as Record<string, number>;
      const rows = compiled.tables.get(input.cost_table ?? '');
      const cost = (n: number) => rows?.rows.find((r) => r[rows.key] === n)?.cost;
      const spent = (input.keys ?? []).reduce((sum, k) => sum + (Number(cost(scores[k])) || 0), 0);
      const budget = input.budget ?? 0;
      const affordable = (k: string, n: number) => {
        const c = cost(n);
        return typeof c === 'number' && spent - (Number(cost(scores[k])) || 0) + c <= budget;
      };
      return (
        <Group header={label} footer={<Txt size={13} color={spent > budget ? p.danger : p.secondary}>{`${spent} of ${budget} points spent`}</Txt>}>
          {(input.keys ?? []).map((k) => {
            const n = scores[k] ?? input.min ?? 0;
            return (
              <Row key={k} title={humanize(k)} trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <IconButton name="minus.circle" android="remove_circle_outline" label={`${humanize(k)} minus`} disabled={(input.min !== undefined && n - 1 < input.min) || !affordable(k, n - 1)} onPress={() => onChange({ ...scores, [k]: n - 1 })} />
                  <Txt weight="600" style={{ minWidth: 28, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{String(n)}</Txt>
                  <IconButton name="plus.circle" android="add_circle_outline" label={`${humanize(k)} plus`} disabled={(input.max !== undefined && n + 1 > input.max) || !affordable(k, n + 1)} onPress={() => onChange({ ...scores, [k]: n + 1 })} />
                </View>
              } />
            );
          })}
        </Group>
      );
    }
  }
}

function Chooser({ title, options, count, compiled, view, onDone, onCancel }: { title: string; options: string[]; count: number; compiled: Compiled; view: SheetView; onDone: (ids: string[]) => void; onCancel: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <>
      <ModalBar title={title} onCancel={onCancel} confirm={{ label: 'Choose', onPress: () => onDone(selected), disabled: selected.length !== count }} />
      <ScrollView contentContainerStyle={styles.screen}>
        <Group footer={count > 1 ? `${selected.length} of ${count} chosen` : undefined}>
          {choiceRows(options, selected, count, (ids) => setSelected(ids as string[]), compiled, view)}
        </Group>
      </ScrollView>
    </>
  );
}

/** Entities to pick from, with checkmarks; with max 1 a tap replaces the selection. */
function choiceRows(options: string[], selected: string[], max: number, onChange: (ids: unknown) => void, compiled: Compiled, view: SheetView) {
  return options.map((id) => {
    const e = compiled.entities.get(id)!.envelope;
    const on = selected.includes(id);
    const toggle = () => onChange(on ? selected.filter((x) => x !== id) : max === 1 ? [id] : selected.length < max ? [...selected, id] : selected);
    return (
      <Row key={id} label={String(e.name)} onPress={toggle} title={String(e.name)}
        subtitle={typeof e.summary === 'string' ? view.text(e.summary, { self: e }) : undefined}
        trailing={on ? <Icon name="checkmark" android="check" size={17} /> : undefined} />
    );
  });
}
