// The engine asks for input through `prompt`; these render those requests. Rendered only from pack data.
import { useTheme } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Switch, TextInput, View as RNView } from 'react-native';

import { type Answer, type Compiled, type PromptRequest, truthy, type View } from '@/engine';
import type { Input } from '@/engine/schema';
import { Button, Card, styles, Txt } from '@/ui/kit';

type Values = Record<string, unknown>;

export function PromptView({ request, compiled, view, onAnswer }: { request: PromptRequest; compiled: Compiled; view: View; onAnswer: (a: Answer | null) => void }) {
  const { colors } = useTheme();
  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      {request.kind === 'modal' ? (
        <PackModal modalId={request.modal} initial={request.with} compiled={compiled} view={view} onAnswer={onAnswer} />
      ) : (
        <Chooser
          title={request.title ?? `Choose ${request.count === 1 ? 'one' : request.count} ${compiled.entityTypes.get(request.entityType)?.label ?? request.entityType}`}
          options={request.options}
          min={request.count}
          max={request.count}
          compiled={compiled}
          view={view}
          onDone={(ids) => onAnswer(ids)}
          onCancel={() => onAnswer(null)}
        />
      )}
    </ScrollView>
  );
}

/** A pack modal: its inputs, then submit (the engine validates again and runs `submit.effects`). */
function PackModal({ modalId, initial, compiled, view, onAnswer }: { modalId: string; initial: Values; compiled: Compiled; view: View; onAnswer: (a: Answer | null) => void }) {
  const modal = compiled.modals.get(modalId)!;
  const [values, setValues] = useState<Values>(() => {
    const out: Values = { ...initial };
    for (const f of modal.fields) if (out[f.key] === undefined && f.default !== undefined) out[f.key] = view.eval(f.default, { input: out });
    return out;
  });
  const vars = { input: values };
  const visible = modal.fields.filter((f) => f.visible_when === undefined || truthy(view.eval(f.visible_when, vars)));
  const missing = visible.filter((f) => f.required && (values[f.key] === undefined || values[f.key] === null || values[f.key] === ''));
  const broken = modal.validate.find((r) => truthy(view.eval(r.when, vars)));
  return (
    <>
      {modal.title ? <Txt size={22} weight="700">{view.text(modal.title, vars)}</Txt> : null}
      {modal.description ? <Txt muted>{view.text(modal.description, vars)}</Txt> : null}
      {visible.map((f) => (
        <Field key={f.key} input={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} compiled={compiled} view={view} vars={vars} />
      ))}
      {broken ? <Txt color="#e5484d">{view.text(broken.message, vars)}</Txt> : null}
      <Button title={modal.submit?.label ? view.text(modal.submit.label, vars) : 'OK'} disabled={missing.length > 0 || broken !== undefined} onPress={() => onAnswer(values)} />
      <Button title="Cancel" kind="secondary" onPress={() => onAnswer(null)} />
    </>
  );
}

function Field({ input, value, onChange, compiled, view, vars }: { input: Input; value: unknown; onChange: (v: unknown) => void; compiled: Compiled; view: View; vars: Values }) {
  const { colors } = useTheme();
  const label = input.label ? view.text(input.label, vars) : input.key;
  const box = { borderColor: colors.border, color: colors.text };
  switch (input.type) {
    case 'number':
    case 'stepper':
      return (
        <RNView style={{ gap: 6 }}>
          <Txt weight="600">{label}</Txt>
          <RNView style={styles.row}>
            {input.type === 'stepper' ? <Button title="−" kind="secondary" onPress={() => onChange(Number(value ?? 0) - (input.step ?? 1))} /> : null}
            <TextInput
              accessibilityLabel={label}
              keyboardType="numbers-and-punctuation"
              value={value === undefined || value === null ? '' : String(value)}
              onChangeText={(t) => onChange(t.trim() === '' ? undefined : Number.isNaN(Number(t)) ? t : Number(t))}
              style={[inputStyle, box, { flex: 1 }]}
              autoFocus
            />
            {input.type === 'stepper' ? <Button title="+" kind="secondary" onPress={() => onChange(Number(value ?? 0) + (input.step ?? 1))} /> : null}
          </RNView>
        </RNView>
      );
    case 'string':
    case 'text':
      return (
        <RNView style={{ gap: 6 }}>
          <Txt weight="600">{label}</Txt>
          <TextInput accessibilityLabel={label} value={typeof value === 'string' ? value : ''} onChangeText={onChange} multiline={input.type === 'text'} style={[inputStyle, box, input.type === 'text' && { minHeight: 96 }]} />
        </RNView>
      );
    case 'boolean':
      return (
        <RNView style={[styles.row, { justifyContent: 'space-between' }]}>
          <Txt>{label}</Txt>
          <Switch accessibilityLabel={label} value={value === true} onValueChange={onChange} />
        </RNView>
      );
    case 'select': {
      const options = typeof input.options === 'string' ? view.eval(input.options, vars) : input.options;
      return (
        <RNView style={{ gap: 6 }}>
          <Txt weight="600">{label}</Txt>
          <RNView style={styles.row}>
            {(Array.isArray(options) ? options : []).map((o) => (
              <Button key={String(o)} title={String(o)} kind={value === o ? 'primary' : 'secondary'} onPress={() => onChange(o)} />
            ))}
          </RNView>
        </RNView>
      );
    }
    case 'choice': {
      const options = (compiled.byType.get(input.entity_type ?? '') ?? [])
        .filter((e) => input.filter === undefined || truthy(view.eval(input.filter, { ...vars, v: e.envelope, k: e.id })))
        .map((e) => e.id);
      return (
        <RNView style={{ gap: 6 }}>
          <Txt weight="600">{label}</Txt>
          <ChoiceList options={options} selected={Array.isArray(value) ? (value as string[]) : []} max={input.max ?? 1} onChange={onChange} compiled={compiled} view={view} />
        </RNView>
      );
    }
    // allocation and assign are wizard inputs (M4)
    default:
      return null;
  }
}

const inputStyle = { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 };

function Chooser({ title, options, min, max, compiled, view, onDone, onCancel }: { title: string; options: string[]; min: number; max: number; compiled: Compiled; view: View; onDone: (ids: string[]) => void; onCancel: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <>
      <Txt size={22} weight="700">{title}</Txt>
      <ChoiceList options={options} selected={selected} max={max} onChange={setSelected} compiled={compiled} view={view} />
      <Button title="Choose" disabled={selected.length < min} onPress={() => onDone(selected)} />
      <Button title="Cancel" kind="secondary" onPress={onCancel} />
    </>
  );
}

/** Entities to pick from; with max 1 a tap replaces the selection. */
function ChoiceList({ options, selected, max, onChange, compiled, view }: { options: string[]; selected: string[]; max: number; onChange: (ids: string[]) => void; compiled: Compiled; view: View }) {
  const { colors } = useTheme();
  return (
    <RNView style={{ gap: 8 }}>
      {options.map((id) => {
        const e = compiled.entities.get(id)!.envelope;
        const on = selected.includes(id);
        const toggle = () => onChange(on ? selected.filter((x) => x !== id) : max === 1 ? [id] : selected.length < max ? [...selected, id] : selected);
        return (
          <Pressable key={id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={toggle}>
            <Card>
              <RNView style={[styles.row, { justifyContent: 'space-between' }]}>
                <Txt weight="600">{String(e.name)}</Txt>
                {on ? <Txt color={colors.primary}>✓</Txt> : null}
              </RNView>
              {typeof e.summary === 'string' ? <Txt muted size={14}>{view.text(e.summary, { self: e })}</Txt> : null}
            </Card>
          </Pressable>
        );
      })}
    </RNView>
  );
}
