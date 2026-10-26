// New character: pick a game system (and expansions), then the pack's creation steps.
// See docs/SPEC.md → Creation wizard.
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Modal, TextInput } from 'react-native';
import semver from 'semver';

import { type Character, data, type InstalledPack, loadPackSet, newestVersions, newId } from '@/data';
import { type Answer, type CharacterPins, type Compiled, createView, type PromptRequest, runCreation, type State } from '@/engine';
import { Group, Icon, IconButton, Row, Screen, TextButton, Txt, usePalette } from '@/ui/kit';
import { SheetContext, type SheetCtx } from '@/ui/sheet/context';
import { Field, initialValues, PromptView, type Values, visibleFields } from '@/ui/sheet/prompts';
import { CharacterCard, SectionView } from '@/ui/sheet/widgets';

type Setup = { pins: CharacterPins; compiled: Compiled };

export default function NewCharacterScreen() {
  const [setup, setSetup] = useState<Setup | null>(null);
  return setup ? <Wizard {...setup} onExit={() => setSetup(null)} /> : <PickPacks onPicked={setSetup} />;
}

function PickPacks({ onPicked }: { onPicked: (s: Setup) => void }) {
  const [packs, setPacks] = useState<InstalledPack[]>([]);
  const [major, setMajor] = useState<string | null>(null);
  const [expansions, setExpansions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useFocusEffect(useCallback(() => {
    data.packs.list().then((list) => {
      const latest = newestVersions(list);
      setPacks(latest);
      setMajor((m) => m ?? latest.find((p) => p.kind === 'major')?.id ?? null);
    });
  }, []));

  const majors = packs.filter((p) => p.kind === 'major');
  const chosen = majors.find((p) => p.id === major);
  const fitting = packs.filter((p) => p.manifest.extends?.id === major && chosen && semver.satisfies(chosen.version, p.manifest.extends.range));

  const next = async () => {
    if (!chosen) return;
    // a character needs at least the versions it was made with, up to the next major
    const pins: CharacterPins = {
      major: { id: chosen.id, range: `^${chosen.version}` },
      expansions: fitting.filter((p) => expansions.includes(p.id)).map((p) => ({ id: p.id, range: `^${p.version}` })),
    };
    setBusy(true);
    const set = await loadPackSet(data, pins);
    setBusy(false);
    if (set.ok) onPicked({ pins, compiled: set.compiled });
    else Alert.alert(set.missing.length ? 'Missing packs' : 'This pack has errors', [...set.missing.map((m) => `Missing ${m.id} ${m.range}`), ...set.issues.filter((i) => i.level === 'error').map((i) => i.message)].join('\n'));
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: 'New character',
          // explicit: the wizard's headerLeft would otherwise outlive it on this same screen
          headerLeft: () => <IconButton name="chevron.backward" android="arrow_back" label="Back" onPress={() => router.back()} />,
          headerRight: () => <TextButton title="Next" bold busy={busy} disabled={!chosen} onPress={() => void next()} />,
        }}
      />
      <Group header="Game system">
        {majors.map((p) => (
          <Row key={p.id} title={p.manifest.name} subtitle={p.version} label={p.manifest.name} onPress={() => { setMajor(p.id); setExpansions([]); }}
            trailing={p.id === major ? <Icon name="checkmark" android="check" size={17} /> : undefined} />
        ))}
      </Group>
      {fitting.length ? (
        <Group header="Expansions">
          {fitting.map((p) => {
            const on = expansions.includes(p.id);
            return (
              <Row key={p.id} title={p.manifest.name} subtitle={p.version} label={p.manifest.name} onPress={() => setExpansions(on ? expansions.filter((x) => x !== p.id) : [...expansions, p.id])}
                trailing={on ? <Icon name="checkmark" android="check" size={17} /> : undefined} />
            );
          })}
        </Group>
      ) : null}
    </Screen>
  );
}

function Wizard({ pins, compiled, onExit }: Setup & { onExit: () => void }) {
  const p = usePalette();
  const steps = compiled.creation?.steps ?? [];
  const [index, setIndex] = useState(0);
  const [name, setName] = useState('');
  const [inputs, setInputs] = useState<Record<string, Values>>({});
  // answers to prompts each step's effects raised, recorded on Next and replayed after
  const [answers, setAnswers] = useState<Record<string, Answer[]>>({});
  // drafts[i]: the character before step i
  const [drafts, setDrafts] = useState<State[]>(() => [createView(compiled, {}).state]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ request: PromptRequest; resolve: (a: Answer | null) => void } | null>(null);

  const step = steps[index];
  const last = steps.length === 0 || index === steps.length - 1;
  const view = useMemo(() => createView(compiled, drafts[index], name || 'New character'), [compiled, drafts, index, name]);
  const defaults = useMemo(() => (step ? initialValues(step.fields, {}, view) : {}), [step, view]);
  const values = step ? inputs[step.id] ?? defaults : {};
  const { visible, missing } = step ? visibleFields(step.fields, values, view) : { visible: [], missing: false };
  const vars = { input: values, steps: inputs };

  const prompt = (request: PromptRequest) => new Promise<Answer | null>((resolve) => setPending({ request, resolve }));
  const recorded = (upTo: number) => steps.slice(0, upTo).flatMap((s) => answers[s.id] ?? []);
  const allInputs = () => (step ? { ...inputs, [step.id]: values } : inputs);

  const fail = (r: Awaited<ReturnType<typeof runCreation>>) => {
    if (!r.ok && 'rejected' in r) Alert.alert('Can’t continue', r.rejected);
  };

  const next = async () => {
    const before = recorded(index);
    setBusy(true);
    const r = await runCreation(compiled, allInputs(), { name, answers: before, prompt, through: step.id });
    setBusy(false);
    if (!r.ok) return fail(r);
    setInputs(allInputs());
    setAnswers((a) => ({ ...a, [step.id]: r.answers.slice(before.length) }));
    setDrafts([...drafts.slice(0, index + 1), r.state]);
    setIndex(index + 1);
  };

  const back = () => {
    if (index === 0) return onExit();
    // the step we return to re-runs on Next, so its answers and every later one go
    const dropped = new Set(steps.slice(index - 1).map((s) => s.id));
    setAnswers((a) => Object.fromEntries(Object.entries(a).filter(([id]) => !dropped.has(id))));
    setDrafts(drafts.slice(0, index));
    setIndex(index - 1);
  };

  const create = async () => {
    setBusy(true);
    const r = await runCreation(compiled, allInputs(), { name: name.trim(), answers: recorded(index), prompt });
    if (!r.ok) { setBusy(false); return fail(r); }
    const now = new Date().toISOString();
    const id = newId();
    const doc: Character = { id, rev: 0, name: name.trim(), created_at: now, updated_at: now, packs: pins, state: r.state, notes: [] };
    await data.characters.put(doc, null);
    router.replace({ pathname: '/c/[id]', params: { id } });
  };

  // the review page previews the first sheet tab, read-only
  const preview: SheetCtx = { compiled, view, readonly: true, action: async () => {}, effects: async () => {}, explain: () => {}, detail: () => {}, notes: [], editNotes: async () => {} };
  const header = compiled.sheet.header;

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: step?.title ? view.text(step.title, vars) : 'New character',
          headerLeft: () => <IconButton name="chevron.backward" android="arrow_back" label="Back" onPress={back} />,
          headerRight: () => last
            ? <TextButton title="Create" bold busy={busy} disabled={missing || name.trim() === ''} onPress={() => void create()} />
            : <TextButton title="Next" bold busy={busy} disabled={missing} onPress={() => void next()} />,
        }}
      />
      {steps.length > 1 ? <Txt muted size={13} style={{ textAlign: 'center' }}>{`Step ${index + 1} of ${steps.length}`}</Txt> : null}
      {last ? (
        <Group header="Name">
          <Row>
            <TextInput accessibilityLabel="Name" value={name} onChangeText={setName} placeholder="Character name" placeholderTextColor={p.secondary} style={{ color: p.text, fontSize: 17 }} />
          </Row>
        </Group>
      ) : null}
      {step?.description ? <Txt muted style={{ paddingHorizontal: 16 }}>{view.text(step.description, vars)}</Txt> : null}
      {visible.map((f) => (
        <Field key={f.key} input={f} value={values[f.key]} compiled={compiled} view={view} vars={vars}
          onChange={(v) => setInputs((s) => ({ ...s, [step.id]: { ...(s[step.id] ?? defaults), [f.key]: v } }))} />
      ))}
      {step?.review ? (
        <SheetContext.Provider value={preview}>
          <CharacterCard title={header?.title ? view.text(header.title) : name.trim() || 'New character'} subtitle={header?.subtitle ? view.text(header.subtitle) : undefined} />
          {compiled.tabs[0]?.sections.map((s, i) => <SectionView key={i} section={s} />)}
        </SheetContext.Provider>
      ) : null}
      <Modal visible={pending !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { pending?.resolve(null); setPending(null); }}>
        {pending ? <PromptView request={pending.request} compiled={compiled} view={view} onAnswer={(a) => { pending.resolve(a); setPending(null); }} /> : null}
      </Modal>
    </Screen>
  );
}
