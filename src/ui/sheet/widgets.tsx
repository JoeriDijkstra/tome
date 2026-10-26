// The widget catalog. Packs compose these; how they look and behave is app code. See SPEC → Widget catalog.
import { MenuView } from '@expo/ui/community/menu';
import type { SFSymbol } from 'expo-symbols';
import { useRef, useState } from 'react';
import { Alert, Pressable, Switch, TextInput, View } from 'react-native';

import { analyze, parse, truthy } from '@/engine';
import type { Section, StatItem } from '@/engine/schema';
import { Group, Icon, IconButton, Prose, Row, TextButton, Txt, usePalette } from '@/ui/kit';

import { type SheetCtx, useSheet } from './context';
import { Notes } from './notes';

type Vars = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

interface ActionInfo {
  id: string;
  label: string;
  enabled: boolean;
  danger: boolean;
  run: () => void;
}

/** A pack action as the sheet sees it: label, visibility, enabled state and confirm come from the pack. */
export function actionInfo(ctx: SheetCtx, id: string, vars?: Vars): ActionInfo | null {
  const { compiled, view, readonly, action } = ctx;
  const a = compiled.actions.get(id);
  if (!a || (a.visible_when !== undefined && !truthy(view.eval(a.visible_when, vars)))) return null;
  const label = view.text(a.label, vars);
  const go = () => void action(id, vars);
  return {
    id,
    label,
    enabled: !readonly && (a.enabled_when === undefined || truthy(view.eval(a.enabled_when, vars))),
    danger: a.style === 'danger',
    run: () => {
      if (!a.confirm) return go();
      Alert.alert(view.text(a.confirm.title, vars), a.confirm.message ? view.text(a.confirm.message, vars) : undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: label, style: a.style === 'danger' ? 'destructive' : 'default', onPress: go },
      ]);
    },
  };
}

export type AppMenuItem = { id: string; title: string; image: SFSymbol; run: () => void };

/** Native menu of pack actions behind a trigger (an ••• icon by default); `app` items follow in their own section. */
export function ActionMenu({ ids, vars, title, app = [], children }: { ids: string[]; vars?: Vars; title?: string; app?: AppMenuItem[]; children?: React.ReactNode }) {
  const ctx = useSheet();
  const actions = ids.map((id) => actionInfo(ctx, id, vars)).filter((a) => a !== null);
  if (actions.length === 0 && app.length === 0) return null;
  // `app:` can't collide with pack ids, which are snake_case
  const appSection = app.length ? [{ id: 'app', title: '', displayInline: true, subactions: app.map((a) => ({ id: `app:${a.id}`, title: a.title, image: a.image })) }] : [];
  return (
    <MenuView
      title={title}
      actions={[...actions.map((a) => ({ id: a.id, title: a.label, attributes: { destructive: a.danger, disabled: !a.enabled } })), ...appSection]}
      onPressAction={({ nativeEvent }) => (actions.find((a) => a.id === nativeEvent.event) ?? app.find((a) => `app:${a.id}` === nativeEvent.event))?.run()}>
      {children ?? <View accessibilityRole="button" accessibilityLabel={title ?? 'Actions'}><Icon name="ellipsis.circle" android="more_horiz" size={22} /></View>}
    </MenuView>
  );
}

/** One action shows as tinted text; several collapse into a menu. */
function Actions({ ids, vars }: { ids: string[]; vars?: Vars }) {
  const ctx = useSheet();
  const visible = ids.map((id) => actionInfo(ctx, id, vars)).filter((a) => a !== null);
  if (visible.length === 0) return null;
  if (visible.length === 1) {
    const a = visible[0];
    return <TextButton title={a.label} danger={a.danger} disabled={!a.enabled} onPress={a.run} />;
  }
  return <ActionMenu ids={ids} vars={vars} />;
}

/** The character's identity at the top of the sheet: avatar, name, and the pack's header subtitle (lineage, class, level…). */
export function CharacterCard({ title, subtitle, onPress }: { title: string; subtitle?: string; onPress?: () => void }) {
  const p = usePalette();
  const initials = title.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]?.toUpperCase()).join('') || '?';
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={[title, subtitle].filter(Boolean).join(', ')} disabled={!onPress} onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 12, backgroundColor: pressed ? p.fill : p.cell })}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: p.tint, alignItems: 'center', justifyContent: 'center' }}>
        <Txt size={22} weight="700" color="#fff">{initials}</Txt>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt size={22} weight="700" lines={1}>{title}</Txt>
        {subtitle ? <Txt muted size={15} lines={2}>{subtitle}</Txt> : null}
      </View>
      {onPress ? <Icon name="chevron.right" android="chevron_right" size={14} color={p.secondary} /> : null}
    </Pressable>
  );
}

export function SectionView({ section }: { section: Section }) {
  const ctx = useSheet();
  const { view } = ctx;
  if (section.visible_when !== undefined && !truthy(view.eval(section.visible_when))) return null;
  switch (section.widget) {
    case 'stat': return <Group><StatRow item={section} /></Group>;
    case 'stat_grid': return <StatGrid title={section.title} columns={section.columns ?? 3} items={section.items} />;
    case 'resource': return <Resource section={section} />;
    case 'list': return <List section={section} />;
    case 'toggles': return <Toggles section={section} />;
    case 'field': return <FieldEditor section={section} />;
    case 'text': return <View style={{ paddingHorizontal: 16 }}><Prose markdown={view.text(section.text)} muted size={15} /></View>;
    case 'actions': {
      const infos = section.actions.map((id) => actionInfo(ctx, id)).filter((a) => a !== null);
      return <Group>{infos.map((a) => <Row key={a.id} title={<TextButton title={a.label} danger={a.danger} disabled={!a.enabled} onPress={a.run} />} />)}</Group>;
    }
    case 'notes': return <Notes />;
  }
}

/** A stat value that is a single reference (`@ac`, `@skills.stealth`) explains itself. */
function explainPath(item: StatItem): string | undefined {
  if (item.explain) return item.explain;
  if (typeof item.value !== 'string') return undefined;
  try {
    const ast = parse(item.value);
    if (ast.t !== 'ref' && ast.t !== 'get') return undefined;
    const refs = analyze(ast).refs;
    return refs.length === 1 ? refs[0].join('.') : undefined;
  } catch {
    return undefined;
  }
}

function useStatPress(item: StatItem): { label: string; onPress?: () => void } {
  const { view, action, explain } = useSheet();
  const label = view.text(item.label);
  const path = explainPath(item);
  const onPress = item.action ? () => void action(item.action!) : path && view.explain(path) ? () => explain(path, label) : undefined;
  return { label, onPress };
}

function StatRow({ item }: { item: StatItem }) {
  const { view } = useSheet();
  const { label, onPress } = useStatPress(item);
  if (item.visible_when !== undefined && !truthy(view.eval(item.visible_when))) return null;
  return (
    <Row title={label} onPress={onPress} label={label} trailing={
      <View style={{ alignItems: 'flex-end' }}>
        <Txt weight="600">{show(view.eval(item.value))}</Txt>
        {item.sub !== undefined ? <Txt muted size={13}>{show(view.eval(item.sub))}</Txt> : null}
      </View>
    } />
  );
}

/** Character-sheet stat block: caption, big value, modifier chip; cells divided by hairlines. */
function StatCell({ item, divider }: { item: StatItem; divider: boolean }) {
  const { view } = useSheet();
  const p = usePalette();
  const { label, onPress } = useStatPress(item);
  if (item.visible_when !== undefined && !truthy(view.eval(item.visible_when))) return <View style={{ flex: 1 }} />;
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label} disabled={!onPress} onPress={onPress}
      style={({ pressed }) => ({ flex: 1, alignItems: 'center', paddingVertical: 12, gap: 2, backgroundColor: pressed ? p.fill : 'transparent', borderLeftWidth: divider ? 0.5 : 0, borderLeftColor: p.separator })}>
      <Txt muted size={11} weight="600" style={{ letterSpacing: 0.6 }}>{label.toUpperCase()}</Txt>
      <Txt size={26} weight="700" style={{ fontVariant: ['tabular-nums'] }}>{show(view.eval(item.value))}</Txt>
      {item.sub !== undefined ? (
        <View style={{ backgroundColor: p.fill, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 1 }}>
          <Txt size={13} weight="600" style={{ fontVariant: ['tabular-nums'] }}>{show(view.eval(item.sub))}</Txt>
        </View>
      ) : null}
    </Pressable>
  );
}

function StatGrid({ title, columns, items }: { title?: string; columns: number; items: StatItem[] }) {
  const { view } = useSheet();
  const rows: StatItem[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return (
    <Group header={title ? view.text(title) : undefined}>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row' }}>
          {row.map((item, j) => <StatCell key={j} item={item} divider={j > 0} />)}
          {Array.from({ length: columns - row.length }, (_, j) => <View key={`pad${j}`} style={{ flex: 1 }} />)}
        </View>
      ))}
    </Group>
  );
}

function Resource({ section }: { section: Extract<Section, { widget: 'resource' }> }) {
  const { view, effects, readonly } = useSheet();
  const p = usePalette();
  const r = view.resources().find((x) => x.id === section.resource);
  if (!r) return null;
  const label = section.label ? view.text(section.label) : r.label;
  const max = r.max ?? 0;
  const current = r.current ?? 0;
  const setCurrent = (n: number) => effects([{ op: 'set', path: `res.${r.id}.current`, value: n }]);
  const add = (d: number) => effects([{ op: 'add', path: `res.${r.id}.current`, value: d }]);
  const style = section.style ?? 'bar';
  const thresholds = section.thresholds?.map((t) => `${view.text(t.label)} ${show(view.eval(t.at))}`).join(' · ');
  return (
    <Group footer={thresholds}>
      <Row
        title={
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Txt weight="600">{label}</Txt>
            <Txt muted size={15} style={{ fontVariant: ['tabular-nums'] }}>{`${current} / ${max}${r.temp ? `  +${r.temp} temp` : ''}`}</Txt>
          </View>
        }
        trailing={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            {style === 'bar' || style === 'counter' ? (
              <>
                <IconButton name="minus.circle" android="remove_circle_outline" label={`${label} minus one`} disabled={readonly || current <= 0} onPress={() => void add(-1)} />
                <IconButton name="plus.circle" android="add_circle_outline" label={`${label} plus one`} disabled={readonly || current >= max} onPress={() => void add(1)} />
              </>
            ) : null}
            {section.actions?.length ? <Actions ids={section.actions} /> : null}
          </View>
        }>
        {style === 'bar' ? (
          <View style={{ height: 6, borderRadius: 3, backgroundColor: p.fill, overflow: 'hidden', marginTop: 6 }}>
            <View style={{ width: `${max > 0 ? (current / max) * 100 : 0}%`, height: '100%', backgroundColor: current / Math.max(max, 1) <= 0.25 ? p.danger : p.tint }} />
          </View>
        ) : style === 'pips' || style === 'slots' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {Array.from({ length: max }, (_, i) => {
              // pips show what's left; slots show what's marked (spent) from the left
              const filled = style === 'pips' ? i < current : i < max - current;
              const tap = style === 'pips' ? () => setCurrent(i < current ? i : i + 1) : () => setCurrent(max - (i < max - current ? i : i + 1));
              return (
                <Pressable key={i} accessibilityRole="button" accessibilityLabel={`${label} ${i + 1}`} disabled={readonly} onPress={tap} hitSlop={4}>
                  <View style={{ width: 20, height: 20, borderRadius: style === 'pips' ? 10 : 5, borderWidth: 1.5, borderColor: p.tint, backgroundColor: filled ? p.tint : 'transparent' }} />
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </Row>
    </Group>
  );
}

function List({ section }: { section: Extract<Section, { widget: 'list' }> }) {
  const ctx = useSheet();
  const { view, compiled, detail } = ctx;
  const p = usePalette();
  const source = view.eval(section.source);
  const rows: [string | number, unknown][] = Array.isArray(source) ? source.map((v, k) => [k, v]) : isObj(source) ? Object.entries(source) : [];
  const groups = new Map<string, [string | number, unknown][]>();
  for (const row of rows) {
    const g = section.group_by !== undefined ? show(view.eval(section.group_by, { v: row[1], k: row[0] })) : '';
    groups.set(g, [...(groups.get(g) ?? []), row]);
  }
  const title = section.title ? view.text(section.title) : undefined;
  const add = section.add ? actionInfo(ctx, section.add) : null;
  const addRow = add ? (
    <Row key="add" label={add.label} onPress={add.enabled ? add.run : undefined} title={
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, opacity: add.enabled ? 1 : 0.35 }}>
        <Icon name="plus.circle.fill" android="add_circle" size={20} />
        <Txt color={p.tint}>{add.label}</Txt>
      </View>
    } />
  ) : null;

  const render = ([k, v]: [string | number, unknown]) => {
    const vars = { v, k };
    const rowTitle = view.text(section.row.title, vars);
    // entity prose is text rendered with $self; feature prose arrives rendered already
    const isEntity = isObj(v) && typeof v.id === 'string' && compiled.entities.get(v.id)?.envelope.type === v.type;
    const body = isObj(v) && typeof v.description === 'string' ? (isEntity ? view.text(v.description, { self: v }) : v.description) : null;
    return { key: String(k), vars, rowTitle, body };
  };

  if (section.style === 'cards') {
    return (
      <View style={{ gap: 6 }}>
        {title ? <Txt muted size={13} style={{ paddingHorizontal: 16 }}>{title.toUpperCase()}</Txt> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {rows.map(render).map(({ key, vars, rowTitle, body }) => (
            <Pressable key={key} disabled={!body} onPress={() => body && detail(rowTitle, body)}
              style={({ pressed }) => ({ width: '48.8%', backgroundColor: pressed ? p.fill : p.cell, borderRadius: 12, padding: 12, gap: 4 })}>
              <Txt weight="600">{rowTitle}</Txt>
              {section.row.subtitle ? <Txt muted size={14}>{view.text(section.row.subtitle, vars)}</Txt> : null}
              {section.row.actions?.length ? <Actions ids={section.row.actions} vars={vars} /> : null}
            </Pressable>
          ))}
        </View>
        {addRow ? <Group>{addRow}</Group> : null}
      </View>
    );
  }

  return (
    <>
      {rows.length === 0 ? (
        <Group header={title} footer={section.empty ? view.text(section.empty) : undefined}>{addRow}</Group>
      ) : null}
      {[...groups].map(([group, items], gi) => (
        <Group key={group || gi} header={group || title}>
          {items.map(render).map(({ key, vars, rowTitle, body }) => (
            <Row
              key={key}
              label={rowTitle}
              title={rowTitle}
              subtitle={section.row.subtitle ? view.text(section.row.subtitle, vars) : undefined}
              onPress={body ? () => detail(rowTitle, body) : undefined}
              trailing={section.row.actions?.length ? <Actions ids={section.row.actions} vars={vars} /> : undefined}>
              {section.row.body ? <Txt size={15}>{view.text(section.row.body, vars)}</Txt> : null}
            </Row>
          ))}
          {gi === groups.size - 1 ? addRow : null}
        </Group>
      ))}
    </>
  );
}

function Toggles({ section }: { section: Extract<Section, { widget: 'toggles' }> }) {
  const { view, effects, readonly, detail } = useSheet();
  type Item = { label: string; on: boolean; toggle: () => void; summary?: string; body?: string };
  const items: Item[] = section.items
    ? section.items.map((it) => ({ label: view.text(it.label), on: truthy(view.eval(`@${it.path}`)), toggle: () => void effects([{ op: 'toggle', path: it.path }]) }))
    : (() => {
        const options = view.eval(section.options!);
        const current = view.eval(`@${section.path!}`);
        return (Array.isArray(options) ? options : []).map((v) => {
          // an option toggles its id (entities) or itself (plain values); entities also say what they do
          const entity = isObj(v) && typeof v.id === 'string';
          const value = entity ? v.id : v;
          return {
            label: view.text(section.label!, { v }),
            on: Array.isArray(current) && current.includes(value),
            toggle: () => void effects([{ op: 'toggle', path: section.path!, value: '$input.value' }], { input: { value } }),
            summary: entity && typeof v.summary === 'string' ? view.text(v.summary, { self: v }) : undefined,
            body: entity && typeof v.description === 'string' ? view.text(v.description, { self: v }) : undefined,
          };
        });
      })();
  return (
    <Group header={section.title ? view.text(section.title) : undefined}>
      {items.map((it, i) => (
        <Row key={i} title={it.label} subtitle={it.summary} onPress={it.body ? () => detail(it.label, it.body!) : undefined}
          trailing={<Switch accessibilityLabel={it.label} value={it.on} disabled={readonly} onValueChange={it.toggle} />} />
      ))}
    </Group>
  );
}

/** Inline editor: commits on submit or blur, once per edit (one undo entry). */
function FieldEditor({ section }: { section: Extract<Section, { widget: 'field' }> }) {
  const { view, effects, readonly } = useSheet();
  const p = usePalette();
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
  const multiline = section.input === 'text';
  const input = (
    <TextInput
      accessibilityLabel={label}
      editable={!readonly}
      value={draft ?? (stored === null || stored === undefined ? '' : String(stored))}
      placeholder={multiline ? label : 'None'}
      placeholderTextColor={p.secondary}
      onChangeText={(t) => { committed.current = null; setDraft(t); }}
      onSubmitEditing={commit}
      onBlur={commit}
      multiline={multiline}
      keyboardType={section.input === 'number' ? 'numbers-and-punctuation' : 'default'}
      autoCorrect={false}
      spellCheck={false}
      style={multiline ? { color: p.text, fontSize: 17, minHeight: 88 } : { color: p.text, fontSize: 17, textAlign: 'right', flex: 1, minWidth: 120 }}
    />
  );
  return multiline ? <Group header={label}><Row>{input}</Row></Group> : <Group><Row title={label} trailing={input} /></Group>;
}
