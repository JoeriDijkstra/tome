import { SegmentedControl } from '@expo/ui/community/segmented-control';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';

import { type Character, data, loadPackSet, type PackSetResult } from '@/data';
import { type Answer, type Breakdown, createView, type PromptRequest, runAction, runBatch } from '@/engine';
import type { Effect } from '@/engine/schema';
import { Button, Group, IconButton, ModalBar, Row, Screen, styles, Txt, usePalette } from '@/ui/kit';
import { SheetContext, type SheetCtx } from '@/ui/sheet/context';
import { PromptView } from '@/ui/sheet/prompts';
import { SheetSession } from '@/ui/sheet/session';
import { ActionMenu, SectionView } from '@/ui/sheet/widgets';

/** the order the engine applies modifiers in, so the breakdown reads top to bottom */
const OP_ORDER = { set: 0, max: 1, min: 2, add: 3 } as const;

export default function SheetScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const [doc, setDoc] = useState<Character | null>(null);
  const [packs, setPacks] = useState<PackSetResult | null>(null);
  const [tab, setTab] = useState(0);
  const [pending, setPending] = useState<{ request: PromptRequest; resolve: (a: Answer | null) => void } | null>(null);
  const [overlay, setOverlay] = useState<{ title: string; body?: string; breakdown?: Breakdown } | null>(null);
  const [undoCount, setUndoCount] = useState(0);
  const [session] = useState(() => new SheetSession((d, depth) => { setDoc(d); setUndoCount(depth); }));

  const load = useCallback(() => {
    data.characters.get(id).then(async (c) => {
      session.loaded(c);
      if (c) setPacks(await loadPackSet(data, c.packs));
    });
  }, [id, session]);
  useFocusEffect(load);

  const compiled = packs?.ok ? packs.compiled : null;
  const view = useMemo(() => (compiled && doc ? createView(compiled, doc.state, doc.name) : null), [compiled, doc]);
  const prompt = useCallback((request: PromptRequest) => new Promise<Answer | null>((resolve) => setPending({ request, resolve })), []);

  const ctx: SheetCtx | null = useMemo(() => {
    if (!compiled || !view || !doc) return null;
    return {
      compiled,
      view,
      readonly: false,
      action: (actionId, vars) => session.write((d) => runAction(compiled, d.state, actionId, { name: d.name, vars, prompt })),
      effects: (effects: Effect[], vars) => session.write((d) => runBatch(compiled, d.state, effects, { name: d.name, vars, prompt })),
      explain: (path, label) => setOverlay({ title: label, breakdown: view.explain(path) }),
      detail: (title, body) => setOverlay({ title, body }),
    };
  }, [compiled, view, doc, session, prompt]);

  if (!doc) return null;
  if (packs && !packs.ok) {
    return (
      <Screen>
        <Stack.Screen options={{ title: doc.name }} />
        <Group header="This character can’t be opened" footer="Install a version of the pack that matches, then come back.">
          {packs.missing.map((m) => <Row key={m.id} title={`Missing ${m.id}`} trailing={<Txt muted>{m.range}</Txt>} />)}
          {packs.issues.filter((i) => i.level === 'error').map((i, n) => <Row key={n} title={<Txt size={15} color={p.danger}>{i.message}</Txt>} subtitle={i.at} />)}
        </Group>
        <Button title="Content packs" onPress={() => router.navigate('/packs')} />
      </Screen>
    );
  }
  if (!ctx || !compiled || !view) return null;

  const header = compiled.sheet.header;
  const current = compiled.tabs[Math.min(tab, compiled.tabs.length - 1)];
  return (
    <SheetContext.Provider value={ctx}>
      <Stack.Screen
        options={{
          title: header?.title ? view.text(header.title) : doc.name,
          headerRight: () => (
            <SheetContext.Provider value={ctx}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <IconButton name="arrow.uturn.backward" android="undo" label="Undo" disabled={undoCount === 0} onPress={() => void session.undo()} />
                {header?.actions?.length ? <ActionMenu ids={header.actions} /> : null}
              </View>
            </SheetContext.Provider>
          ),
        }}
      />
      <Screen>
        {header?.subtitle || compiled.tabs.length > 1 ? (
          <View style={{ gap: 12 }}>
            {header?.subtitle ? <Txt muted style={{ textAlign: 'center' }}>{view.text(header.subtitle)}</Txt> : null}
            {compiled.tabs.length > 1 ? (
              <SegmentedControl values={compiled.tabs.map((t) => view.text(t.label))} selectedIndex={compiled.tabs.indexOf(current)} onChange={(e) => setTab(e.nativeEvent.selectedSegmentIndex)} style={{ height: 32 }} />
            ) : null}
          </View>
        ) : null}
        {current?.sections.map((s, i) => <SectionView key={`${current.id}-${i}`} section={s} />)}
        {view.warnings.size ? (
          <Group header={`${view.warnings.size} pack warning${view.warnings.size === 1 ? '' : 's'}`}>
            {[...view.warnings].map((w) => <Row key={w} title={<Txt size={13} color={p.warning}>{w}</Txt>} />)}
          </Group>
        ) : null}
      </Screen>
      <Modal visible={pending !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { pending?.resolve(null); setPending(null); }}>
        {pending ? <PromptView request={pending.request} compiled={compiled} view={view} onAnswer={(a) => { pending.resolve(a); setPending(null); }} /> : null}
      </Modal>
      <Modal visible={overlay !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOverlay(null)}>
        {overlay ? <Overlay {...overlay} names={(source) => String(compiled.entities.get(source)?.envelope.name ?? source)} onClose={() => setOverlay(null)} /> : null}
      </Modal>
    </SheetContext.Provider>
  );
}

function Overlay({ title, body, breakdown, names, onClose }: { title: string; body?: string; breakdown?: Breakdown; names: (source: string) => string; onClose: () => void }) {
  const p = usePalette();
  const fmt = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
  const signed = (v: number | null) => (v === null ? '—' : v >= 0 ? `+${v}` : String(v));
  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <ModalBar title={title} onCancel={onClose} cancelLabel="Close" />
      <ScrollView contentContainerStyle={styles.screen}>
        {body ? <Group><Row><Txt>{body}</Txt></Row></Group> : null}
        {breakdown ? (
          <Group>
            <Row title="Base" trailing={<Txt muted>{fmt(breakdown.base)}</Txt>} />
            {[...breakdown.contributions].sort((a, b) => OP_ORDER[a.op] - OP_ORDER[b.op]).map((c, i) => (
              <Row
                key={i}
                title={<Txt muted={!c.applied}>{names(c.source)}</Txt>}
                subtitle={c.applied ? (c.type ?? undefined) : `${c.type ? `${c.type}, ` : ''}not applied`}
                trailing={<Txt muted={!c.applied} style={{ fontVariant: ['tabular-nums'] }}>{c.op === 'add' ? signed(c.value) : `${c.op} ${fmt(c.value)}`}</Txt>}
              />
            ))}
            <Row title={<Txt weight="600">Total</Txt>} trailing={<Txt weight="700">{fmt(breakdown.value)}</Txt>} />
          </Group>
        ) : null}
      </ScrollView>
    </View>
  );
}
