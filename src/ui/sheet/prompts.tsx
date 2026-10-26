// The engine asks for input through `prompt`; these render those requests as native-style forms.
import { useState } from 'react';
import { ScrollView, Switch, TextInput, View } from 'react-native';

import { type Answer, type Compiled, type PromptRequest, truthy, type View as SheetView } from '@/engine';
import type { Input } from '@/engine/schema';
import { Group, Icon, IconButton, ModalBar, Row, styles, Txt, usePalette } from '@/ui/kit';

type Values = Record<string, unknown>;

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
  const [values, setValues] = useState<Values>(() => {
    const out: Values = { ...initial };
    for (const f of modal.fields) if (out[f.key] === undefined && f.default !== undefined) out[f.key] = view.eval(f.default, { input: out });
    return out;
  });
  const vars = { input: values };
  const visible = modal.fields.filter((f) => f.visible_when === undefined || truthy(view.eval(f.visible_when, vars)));
  const missing = visible.some((f) => f.required && (values[f.key] === undefined || values[f.key] === null || values[f.key] === ''));
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

function Field({ input, value, onChange, compiled, view, vars }: { input: Input; value: unknown; onChange: (v: unknown) => void; compiled: Compiled; view: SheetView; vars: Values }) {
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
            <Row key={String(o)} title={String(o)} label={String(o)} onPress={() => onChange(o)} trailing={value === o ? <Icon name="checkmark" android="check" size={17} /> : undefined} />
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
    // allocation and assign are wizard inputs (M4)
    default:
      return null;
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
