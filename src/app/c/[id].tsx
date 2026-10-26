import { router, Stack, useFocusEffect, useLocalSearchParams, useTheme } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { type Character, data, loadPackSet, type PackSetResult } from '@/data';
import { type Answer, type Breakdown, createView, type PromptRequest, runAction, runBatch } from '@/engine';
import type { Effect } from '@/engine/schema';
import { Button, Card, Screen, styles, Txt } from '@/ui/kit';
import { SheetContext, type SheetCtx } from '@/ui/sheet/context';
import { PromptView } from '@/ui/sheet/prompts';
import { SheetSession } from '@/ui/sheet/session';
import { PackButton, SectionView } from '@/ui/sheet/widgets';

/** the order the engine applies modifiers in, so the breakdown reads top to bottom */
const OP_ORDER = { set: 0, max: 1, min: 2, add: 3 } as const;

export default function SheetScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
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

  const undoLast = () => session.undo();

  if (!doc) return null;
  if (packs && !packs.ok) {
    return (
      <Screen>
        <Stack.Screen options={{ title: doc.name }} />
        <Card>
          <Txt weight="600">This character can’t be opened</Txt>
          {packs.missing.map((m) => <Txt key={m.id}>{`Missing pack ${m.id} ${m.range}`}</Txt>)}
          {packs.issues.filter((i) => i.level === 'error').map((i, n) => <Txt key={n} size={13} color={colors.notification}>{`${i.message} (${i.at})`}</Txt>)}
        </Card>
        <Button title="Content packs" onPress={() => router.push('/packs')} />
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
            <Pressable accessibilityRole="button" accessibilityLabel="Undo" disabled={undoCount === 0} onPress={undoLast} hitSlop={8} style={{ opacity: undoCount ? 1 : 0.3 }}>
              <SymbolView name={{ ios: 'arrow.uturn.backward', android: 'undo' }} size={22} tintColor={colors.primary} />
            </Pressable>
          ),
        }}
      />
      <Screen>
        {header?.subtitle ? <Txt muted>{view.text(header.subtitle)}</Txt> : null}
        {header?.actions?.length ? <View style={styles.row}>{header.actions.map((a) => <PackButton key={a} id={a} />)}</View> : null}
        {compiled.tabs.length > 1 ? (
          <View style={styles.row}>
            {compiled.tabs.map((t, i) => <Button key={t.id} title={view.text(t.label)} kind={t === current ? 'primary' : 'secondary'} onPress={() => setTab(i)} />)}
          </View>
        ) : null}
        {current?.sections.map((s, i) => <SectionView key={`${current.id}-${i}`} section={s} />)}
        {view.warnings.size ? (
          <Card>
            <Txt weight="600" color={colors.notification}>{`${view.warnings.size} pack warning${view.warnings.size === 1 ? '' : 's'}`}</Txt>
            {[...view.warnings].map((w) => <Txt key={w} muted size={12}>{w}</Txt>)}
          </Card>
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
  const { colors } = useTheme();
  const fmt = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.screen}>
      <Txt size={22} weight="700">{title}</Txt>
      {body ? <Txt>{body}</Txt> : null}
      {breakdown ? (
        <Card>
          <Txt>{`Base ${fmt(breakdown.base)}`}</Txt>
          {[...breakdown.contributions].sort((a, b) => OP_ORDER[a.op] - OP_ORDER[b.op]).map((c, i) => (
            <Txt key={i} muted={!c.applied}>
              {`${c.op === 'add' && (c.value ?? 0) >= 0 ? '+' : ''}${c.op === 'add' ? fmt(c.value) : `${c.op} ${fmt(c.value)}`} ${names(c.source)}${c.type ? ` (${c.type})` : ''}${c.applied ? '' : ' — not applied'}`}
            </Txt>
          ))}
          <Txt weight="700">{`= ${fmt(breakdown.value)}`}</Txt>
        </Card>
      ) : null}
      <Button title="Close" kind="secondary" onPress={onClose} />
    </ScrollView>
  );
}
