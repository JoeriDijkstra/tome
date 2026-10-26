// The widget catalog. Packs compose these; how they look and behave is app code. See SPEC → Widget catalog.
import { useTheme } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Switch, TextInput, View } from 'react-native';

import { analyze, parse, truthy } from '@/engine';
import type { Section, StatItem } from '@/engine/schema';
import { Button, Card, styles, Txt } from '@/ui/kit';

import { useSheet } from './context';

type Vars = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** A pack action as a button: label, style, visibility, enabled state and confirm come from the pack. */
export function PackButton({ id, vars }: { id: string; vars?: Vars }) {
  const { compiled, view, readonly, action } = useSheet();
  const [busy, setBusy] = useState(false);
  const a = compiled.actions.get(id);
  if (!a || (a.visible_when !== undefined && !truthy(view.eval(a.visible_when, vars)))) return null;
  const enabled = !readonly && (a.enabled_when === undefined || truthy(view.eval(a.enabled_when, vars)));
  const label = view.text(a.label, vars);
  const go = async () => {
    setBusy(true);
    try {
      await action(id, vars);
    } finally {
      setBusy(false);
    }
  };
  const press = () => {
    if (!a.confirm) return void go();
    Alert.alert(view.text(a.confirm.title, vars), a.confirm.message ? view.text(a.confirm.message, vars) : undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: label, style: a.style === 'danger' ? 'destructive' : 'default', onPress: () => void go() },
    ]);
  };
  const kind = a.style === 'danger' ? 'danger' : a.style === 'primary' ? 'primary' : 'secondary';
  return <Button title={label} kind={kind} disabled={!enabled} busy={busy} onPress={press} />;
}

export function SectionView({ section }: { section: Section }) {
  const { view } = useSheet();
  if (section.visible_when !== undefined && !truthy(view.eval(section.visible_when))) return null;
  switch (section.widget) {
    case 'stat': return <Stat item={section} />;
    case 'stat_grid': return <StatGrid title={section.title} columns={section.columns ?? 3} items={section.items} />;
    case 'resource': return <Resource section={section} />;
    case 'list': return <List section={section} />;
    case 'toggles': return <Toggles section={section} />;
    case 'field': return <FieldEditor section={section} />;
    case 'text': return <Card><Txt>{view.text(section.text)}</Txt></Card>;
    case 'actions': return <View style={styles.row}>{section.actions.map((id) => <PackButton key={id} id={id} />)}</View>;
    // the journal arrives with M5
    case 'notes': return null;
  }
}

/** A stat value that is a single reference (`@ac`, `@skills.stealth`) explains itself. */
function inferredExplain(value: StatItem['value']): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const ast = parse(value);
    if (ast.t !== 'ref' && ast.t !== 'get') return undefined;
    const refs = analyze(ast).refs;
    return refs.length === 1 ? refs[0].join('.') : undefined;
  } catch {
    return undefined;
  }
}

function Stat({ item }: { item: StatItem }) {
  const { view, action, explain } = useSheet();
  const { colors } = useTheme();
  if (item.visible_when !== undefined && !truthy(view.eval(item.visible_when))) return null;
  const label = view.text(item.label);
  const path = item.explain ?? inferredExplain(item.value);
  const onPress = item.action ? () => void action(item.action!) : path && view.explain(path) ? () => explain(path, label) : undefined;
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label} disabled={!onPress} onPress={onPress} style={{ flex: 1 }}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, alignItems: 'center' }]}>
        <Txt muted size={12} weight="600">{label.toUpperCase()}</Txt>
        <Txt size={24} weight="700">{show(view.eval(item.value))}</Txt>
        {item.sub !== undefined ? <Txt muted size={13}>{show(view.eval(item.sub))}</Txt> : null}
      </View>
    </Pressable>
  );
}

function StatGrid({ title, columns, items }: { title?: string; columns: number; items: StatItem[] }) {
  const { view } = useSheet();
  const rows: StatItem[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return (
    <View style={{ gap: 8 }}>
      {title ? <Txt weight="600">{view.text(title)}</Txt> : null}
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
          {row.map((item, j) => <Stat key={j} item={item} />)}
          {Array.from({ length: columns - row.length }, (_, j) => <View key={`pad${j}`} style={{ flex: 1 }} />)}
        </View>
      ))}
    </View>
  );
}

function Resource({ section }: { section: Extract<Section, { widget: 'resource' }> }) {
  const { view, effects, readonly } = useSheet();
  const { colors } = useTheme();
  const r = view.resources().find((x) => x.id === section.resource);
  if (!r) return null;
  const label = section.label ? view.text(section.label) : r.label;
  const max = r.max ?? 0;
  const current = r.current ?? 0;
  const setCurrent = (n: number) => effects([{ op: 'set', path: `res.${r.id}.current`, value: n }]);
  const add = (d: number) => effects([{ op: 'add', path: `res.${r.id}.current`, value: d }]);
  const style = section.style ?? 'bar';
  return (
    <Card>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Txt weight="600">{label}</Txt>
        <Txt>{`${current} / ${max}${r.temp ? ` (+${r.temp})` : ''}`}</Txt>
      </View>
      {style === 'bar' ? (
        <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' }}>
          <View style={{ width: `${max > 0 ? (current / max) * 100 : 0}%`, height: '100%', backgroundColor: colors.primary }} />
        </View>
      ) : style === 'pips' || style === 'slots' ? (
        <View style={styles.row}>
          {Array.from({ length: max }, (_, i) => {
            // pips show what's left; slots show what's marked (spent) from the left
            const filled = style === 'pips' ? i < current : i < max - current;
            const tap = style === 'pips' ? () => setCurrent(i < current ? i : i + 1) : () => setCurrent(max - (i < max - current ? i : i + 1));
            return (
              <Pressable key={i} accessibilityRole="button" accessibilityLabel={`${label} ${i + 1}`} disabled={readonly} onPress={tap} hitSlop={4}>
                <View style={{ width: 22, height: 22, borderRadius: style === 'pips' ? 11 : 4, borderWidth: 2, borderColor: colors.primary, backgroundColor: filled ? colors.primary : 'transparent' }} />
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {section.thresholds?.length ? (
        <Txt muted size={13}>{section.thresholds.map((t) => `${view.text(t.label)} ${show(view.eval(t.at))}`).join(' · ')}</Txt>
      ) : null}
      <View style={styles.row}>
        {style !== 'slots' ? (
          <>
            <Button title="−" kind="secondary" disabled={readonly || current <= 0} onPress={() => void add(-1)} />
            <Button title="+" kind="secondary" disabled={readonly || current >= max} onPress={() => void add(1)} />
          </>
        ) : null}
        {section.actions?.map((id) => <PackButton key={id} id={id} />)}
      </View>
    </Card>
  );
}

function List({ section }: { section: Extract<Section, { widget: 'list' }> }) {
  const { view, compiled, detail } = useSheet();
  const source = view.eval(section.source);
  const rows: [string | number, unknown][] = Array.isArray(source) ? source.map((v, k) => [k, v]) : isObj(source) ? Object.entries(source) : [];
  const groups = new Map<string, [string | number, unknown][]>();
  for (const row of rows) {
    const g = section.group_by !== undefined ? show(view.eval(section.group_by, { v: row[1], k: row[0] })) : '';
    groups.set(g, [...(groups.get(g) ?? []), row]);
  }
  const cards = section.style === 'cards';
  return (
    <View style={{ gap: 8 }}>
      {section.title ? <Txt weight="600">{view.text(section.title)}</Txt> : null}
      {rows.length === 0 && section.empty ? <Txt muted>{view.text(section.empty)}</Txt> : null}
      {[...groups].map(([group, items]) => (
        <View key={group} style={{ gap: 8 }}>
          {group ? <Txt muted size={13} weight="600">{group.toUpperCase()}</Txt> : null}
          <View style={cards ? [styles.row, { alignItems: 'stretch' }] : { gap: 8 }}>
            {items.map(([k, v]) => {
              const vars = { v, k };
              const title = view.text(section.row.title, vars);
              // entity prose is text rendered with $self; feature prose arrives rendered already
              const isEntity = isObj(v) && typeof v.id === 'string' && compiled.entities.get(v.id)?.envelope.type === v.type;
              const body = isObj(v) && typeof v.description === 'string' ? (isEntity ? view.text(v.description, { self: v }) : v.description) : null;
              return (
                <Pressable key={String(k)} disabled={!body} onPress={() => body && detail(title, body)} style={cards ? { width: '48%' } : undefined}>
                  <Card>
                    <Txt weight="600">{title}</Txt>
                    {section.row.subtitle ? <Txt muted size={14}>{view.text(section.row.subtitle, vars)}</Txt> : null}
                    {section.row.body ? <Txt size={14}>{view.text(section.row.body, vars)}</Txt> : null}
                    {section.row.actions?.length ? <View style={styles.row}>{section.row.actions.map((id) => <PackButton key={id} id={id} vars={vars} />)}</View> : null}
                  </Card>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      {section.add ? <PackButton id={section.add} /> : null}
    </View>
  );
}

function Toggles({ section }: { section: Extract<Section, { widget: 'toggles' }> }) {
  const { view, effects, readonly } = useSheet();
  const items: { label: string; on: boolean; toggle: () => void }[] = section.items
    ? section.items.map((it) => ({ label: view.text(it.label), on: truthy(view.eval(`@${it.path}`)), toggle: () => void effects([{ op: 'toggle', path: it.path }]) }))
    : (() => {
        const options = view.eval(section.options!);
        const current = view.eval(`@${section.path!}`);
        return (Array.isArray(options) ? options : []).map((v) => {
          // an option toggles its id (entities) or itself (plain values)
          const value = isObj(v) && typeof v.id === 'string' ? v.id : v;
          return {
            label: view.text(section.label!, { v }),
            on: Array.isArray(current) && current.includes(value),
            toggle: () => void effects([{ op: 'toggle', path: section.path!, value: '$input.value' }], { input: { value } }),
          };
        });
      })();
  return (
    <Card>
      {section.title ? <Txt weight="600">{view.text(section.title)}</Txt> : null}
      {items.map((it, i) => (
        <View key={i} style={[styles.row, { justifyContent: 'space-between' }]}>
          <Txt>{it.label}</Txt>
          <Switch accessibilityLabel={it.label} value={it.on} disabled={readonly} onValueChange={it.toggle} />
        </View>
      ))}
    </Card>
  );
}

/** Inline editor: commits on submit or blur, once per edit (one undo entry). */
function FieldEditor({ section }: { section: Extract<Section, { widget: 'field' }> }) {
  const { view, effects, readonly } = useSheet();
  const { colors } = useTheme();
  const stored = view.eval(`@base.${section.path}`);
  const [draft, setDraft] = useState<string | null>(null);
  // submit and blur can both fire for one edit; only the first may write
  const committed = useRef<string | null>(null);
  const label = view.text(section.label);
  const commit = () => {
    if (draft === null || committed.current === draft) return;
    committed.current = draft;
    const value = section.input === 'number' ? Number(draft) : draft;
    setDraft(null);
    if (value !== stored) void effects([{ op: 'set', path: section.path, value: '$input.value' }], { input: { value } });
  };
  return (
    <View style={{ gap: 6 }}>
      <Txt weight="600">{label}</Txt>
      <TextInput
        accessibilityLabel={label}
        editable={!readonly}
        value={draft ?? (stored === null || stored === undefined ? '' : String(stored))}
        onChangeText={(t) => { committed.current = null; setDraft(t); }}
        onSubmitEditing={commit}
        onBlur={commit}
        multiline={section.input === 'text'}
        keyboardType={section.input === 'number' ? 'numbers-and-punctuation' : 'default'}
        autoCorrect={false}
        spellCheck={false}
        style={{ borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16, borderColor: colors.border, color: colors.text }}
      />
    </View>
  );
}
