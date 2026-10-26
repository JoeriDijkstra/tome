import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { Tabs } from 'react-native-screens';

import { type Character, data, loadPackSet, type PackSetResult } from '@/data';
import { type Answer, type Breakdown, createView, type PromptRequest, runAction, runBatch, truthy } from '@/engine';
import type { Effect, Tab } from '@/engine/schema';
import { Button, Group, IconButton, ModalBar, PACK_ICONS, Prose, Row, Screen, styles, TextButton, Txt, usePalette } from '@/ui/kit';
import { SheetContext, type SheetCtx } from '@/ui/sheet/context';
import { PromptView } from '@/ui/sheet/prompts';
import { CharacterSettings } from '@/ui/sheet/settings';
import { SheetSession } from '@/ui/sheet/session';
import { ActionMenu, CharacterCard, SectionView } from '@/ui/sheet/widgets';

/** the order the engine applies modifiers in, so the breakdown reads top to bottom */
const OP_ORDER = { set: 0, max: 1, min: 2, add: 3 } as const;

export default function SheetScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const [doc, setDoc] = useState<Character | null>(null);
  const [packs, setPacks] = useState<PackSetResult | null>(null);
  // the native tab bar echoes a provenance with each selection; we hand it back with the next request
  const [nav, setNav] = useState<{ key: string | null; provenance: number }>({ key: null, provenance: 0 });
  const [pending, setPending] = useState<{ request: PromptRequest; resolve: (a: Answer | null) => void } | null>(null);
  const [overlay, setOverlay] = useState<{ title: string; body?: string; breakdown?: Breakdown } | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
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
      open: setPageId,
      notes: doc.notes ?? [],
      editNotes: (change) => session.edit((d) => ({ ...d, notes: change(d.notes ?? []) })),
    };
  }, [compiled, view, doc, session, prompt]);

  if (!doc) return null;
  const settingsModal = (
    <Modal visible={settings} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSettings(false)}>
      {settings ? (
        <CharacterSettings doc={doc} edit={(change) => session.edit(change)} onClose={() => setSettings(false)}
          onPinsChanged={(pins) => void loadPackSet(data, pins).then(setPacks)}
          onDelete={() => { setSettings(false); void data.characters.delete(doc.id).then(() => router.back()); }} />
      ) : null}
    </Modal>
  );
  if (packs && !packs.ok) {
    return (
      <Screen>
        <Stack.Screen options={{ title: doc.name }} />
        <Group header="This character can’t be opened" footer="Install a version of the pack that matches, then come back.">
          {packs.missing.map((m) => <Row key={m.id} title={`Missing ${m.id}`} trailing={<Txt muted>{m.range}</Txt>} />)}
          {packs.issues.filter((i) => i.level === 'error').map((i, n) => <Row key={n} title={<Txt size={15} color={p.danger}>{i.message}</Txt>} subtitle={i.at} />)}
        </Group>
        <Button title="Content packs" onPress={() => router.navigate('/packs')} />
        <Group>
          <Row title={<TextButton title="Character settings" onPress={() => setSettings(true)} />} />
        </Group>
        {settingsModal}
      </Screen>
    );
  }
  if (!ctx || !compiled || !view) return null;

  const header = compiled.sheet.header;
  // a pack hides tabs that don't apply to this character
  const tabs = compiled.tabs.filter((t) => t.visible_when === undefined || truthy(view.eval(t.visible_when)));
  const current = tabs.find((t) => t.id === nav.key) ?? tabs[0];
  const name = header?.title ? view.text(header.title) : doc.name;
  const first = current === tabs[0];
  const page = (tab: Tab | undefined) => (
    <Screen>
      {/* the card is the character's identity, so it heads the first tab; tapping it opens settings */}
      {tab === tabs[0] ? <CharacterCard title={name} subtitle={header?.subtitle ? view.text(header.subtitle) : undefined} onPress={() => setSettings(true)} /> : null}
      {tab?.sections.map((s, i) => <SectionView key={`${tab.id}-${i}`} section={s} />)}
      {view.warnings.size ? (
        <Group header={`${view.warnings.size} pack warning${view.warnings.size === 1 ? '' : 's'}`}>
          {[...view.warnings].map((w) => <Row key={w} title={<Txt size={13} color={p.warning}>{w}</Txt>} />)}
        </Group>
      ) : null}
    </Screen>
  );
  const pageView = pageId ? compiled.pages.get(pageId) : undefined;
  const dialogs = (
    <>
      <Modal visible={pending !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { pending?.resolve(null); setPending(null); }}>
        {pending ? <PromptView request={pending.request} compiled={compiled} view={view} onAnswer={(a) => { pending.resolve(a); setPending(null); }} /> : null}
      </Modal>
      <Modal visible={overlay !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOverlay(null)}>
        {overlay ? <Overlay {...overlay} names={(source) => String(compiled.entities.get(source)?.envelope.name ?? source)} onClose={() => setOverlay(null)} /> : null}
      </Modal>
    </>
  );
  return (
    <SheetContext.Provider value={ctx}>
      <Stack.Screen
        options={{
          // the first tab's card already shows the name
          title: first ? '' : name,
          headerRight: () => (
            <SheetContext.Provider value={ctx}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <IconButton name="arrow.uturn.backward" android="undo" label="Undo" disabled={undoCount === 0} onPress={() => void session.undo()} />
                <ActionMenu ids={header?.actions ?? []} app={[{ id: 'settings', title: 'Character settings', image: 'gearshape', run: () => setSettings(true) }]} />
              </View>
            </SheetContext.Provider>
          ),
        }}
      />
      {tabs.length > 1 ? (
        <View style={{ flex: 1 }}>
          <Tabs.Host
            navStateRequest={{ selectedScreenKey: current.id, baseProvenance: nav.provenance }}
            ios={{ tabBarTintColor: p.tint }}
            onTabSelected={(e) => setNav({ key: e.nativeEvent.selectedScreenKey, provenance: e.nativeEvent.provenance })}>
            {/* ponytail: SF Symbols only; Android tabs show titles until icons ship as drawables */}
            {tabs.map((t) => (
              <Tabs.Screen key={t.id} screenKey={t.id} title={view.text(t.label)} ios={{ icon: { type: 'sfSymbol', name: PACK_ICONS[t.icon ?? 'list'].ios } }}>
                {page(t)}
              </Tabs.Screen>
            ))}
          </Tabs.Host>
        </View>
      ) : page(current)}
      {pageView ? null : dialogs}
      {/* a pack page over the sheet; its widgets write through the same session, so it stays live */}
      <Modal visible={pageView !== undefined} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPageId(null)}>
        {pageView ? (
          <View style={{ flex: 1, backgroundColor: p.background }}>
            <ModalBar title={view.text(pageView.label)} onCancel={() => setPageId(null)} cancelLabel="Done" />
            <ScrollView contentContainerStyle={styles.screen}>
              {pageView.sections.map((s, i) => <SectionView key={`${pageView.id}-${i}`} section={s} />)}
            </ScrollView>
            {/* iOS presents a modal only from the topmost one, so a page hosts the dialogs its widgets open */}
            {dialogs}
          </View>
        ) : null}
      </Modal>
      {settingsModal}
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
        {body ? <Group><Row><Prose markdown={body} /></Row></Group> : null}
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
