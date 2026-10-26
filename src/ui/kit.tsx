// App-owned building blocks in the platform's own idiom: inset grouped lists, tinted text buttons, SF Symbols.
// Packs never style these; they only compose them (see SPEC → Sheet UI).
import { type Theme, useTheme } from 'expo-router';
import { type SFSymbol, SymbolView } from 'expo-symbols';
import { Children, isValidElement, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, type TextStyle, View, type ViewStyle } from 'react-native';

// iOS system colors (grouped backgrounds, separators, labels), used on both platforms for one consistent look
const LIGHT = { background: '#F2F2F7', cell: '#FFFFFF', separator: '#C6C6C8', text: '#000000', secondary: '#3C3C4399', tint: '#007AFF', danger: '#FF3B30', warning: '#B7791F', fill: '#7676801F' };
const DARK = { background: '#000000', cell: '#1C1C1E', separator: '#38383A', text: '#FFFFFF', secondary: '#EBEBF599', tint: '#0A84FF', danger: '#FF453A', warning: '#FFD60A', fill: '#7676803D' };
export type Palette = typeof LIGHT;

/** The navigation theme for a color scheme, matched to the palette. */
export function navigationTheme(base: Theme, dark: boolean): Theme {
  const p = dark ? DARK : LIGHT;
  return { ...base, dark, colors: { ...base.colors, background: p.background, card: p.background, text: p.text, border: p.separator, primary: p.tint, notification: p.danger } };
}

export function usePalette(): Palette {
  return useTheme().dark ? DARK : LIGHT;
}

export function Txt({ children, muted, size = 17, weight, color, style, lines }: { children: ReactNode; muted?: boolean; size?: number; weight?: TextStyle['fontWeight']; color?: string; style?: TextStyle; lines?: number }) {
  const p = usePalette();
  return <Text numberOfLines={lines} style={[{ color: color ?? (muted ? p.secondary : p.text), fontSize: size, fontWeight: weight }, style]}>{children}</Text>;
}

export function Icon({ name, android, size = 20, color }: { name: SFSymbol; android: string; size?: number; color?: string }) {
  const p = usePalette();
  // expo-symbols types Android names as its own union; packs never pick icons, so the app's few names are safe
  return <SymbolView name={{ ios: name, android: android as never }} size={size} tintColor={color ?? p.tint} />;
}

/** A filled call-to-action; only for empty states and modal-less primary actions. */
export function Button({ title, onPress, disabled, busy }: { title: string; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: p.tint, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 }]}>
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{title}</Text>}
    </Pressable>
  );
}

/** Tinted text, no chrome: the platform's default for actions inside lists and bars. */
export function TextButton({ title, onPress, disabled, busy, danger, bold, label }: { title: string; onPress: () => void; disabled?: boolean; busy?: boolean; danger?: boolean; bold?: boolean; label?: string }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} accessibilityState={{ disabled }} disabled={disabled || busy} onPress={onPress} hitSlop={8} style={({ pressed }) => ({ opacity: disabled ? 0.35 : pressed ? 0.5 : 1 })}>
      {busy ? <ActivityIndicator /> : <Text style={{ color: danger ? p.danger : p.tint, fontSize: 17, fontWeight: bold ? '600' : '400' }}>{title}</Text>}
    </Pressable>
  );
}

export function IconButton({ name, android, label, onPress, disabled, size = 22 }: { name: SFSymbol; android: string; label: string; onPress: () => void; disabled?: boolean; size?: number }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={10} style={({ pressed }) => ({ opacity: disabled ? 0.3 : pressed ? 0.5 : 1 })}>
      <Icon name={name} android={android} size={size} />
    </Pressable>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  return <ScrollView contentContainerStyle={styles.screen} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}

/** Inset grouped section: caption above, rounded cell group, footnote below. Children are separated by hairlines. */
export function Group({ header, footer, children, style }: { header?: string; footer?: ReactNode; children?: ReactNode; style?: ViewStyle }) {
  const p = usePalette();
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.group}>
      {header ? <Text style={[styles.caption, { color: p.secondary }]}>{header.toUpperCase()}</Text> : null}
      {items.length ? (
        <View style={[styles.cells, { backgroundColor: p.cell }, style]}>
          {items.map((child, i) => (
            <View key={i}>
              {i > 0 ? <View style={[styles.separator, { backgroundColor: p.separator }]} /> : null}
              {child}
            </View>
          ))}
        </View>
      ) : null}
      {footer ? <View style={styles.footer}>{typeof footer === 'string' ? <Txt muted size={13}>{footer}</Txt> : footer}</View> : null}
    </View>
  );
}

/** A list row: title, optional subtitle, trailing content; a chevron when it navigates. */
export function Row({ title, subtitle, trailing, onPress, onLongPress, chevron, children, label }: { title?: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; onPress?: () => void; onLongPress?: () => void; chevron?: boolean; children?: ReactNode; label?: string }) {
  const p = usePalette();
  const body = (
    <View style={styles.row}>
      <View style={{ flex: 1, gap: 2 }}>
        {typeof title === 'string' ? <Txt>{title}</Txt> : title}
        {typeof subtitle === 'string' ? <Txt muted size={15}>{subtitle}</Txt> : subtitle}
        {children}
      </View>
      {trailing}
      {chevron ? <Icon name="chevron.right" android="chevron_right" size={14} color={p.secondary} /> : null}
    </View>
  );
  if (!onPress && !onLongPress) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} onLongPress={onLongPress} style={({ pressed }) => ({ backgroundColor: pressed ? p.fill : 'transparent' })}>
      {body}
    </Pressable>
  );
}

/** Modal title bar: Cancel on the left, the confirming action on the right. */
export function ModalBar({ title, onCancel, cancelLabel = 'Cancel', confirm }: { title: string; onCancel: () => void; cancelLabel?: string; confirm?: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean } }) {
  return (
    <View style={styles.modalBar}>
      <View style={{ flex: 1, alignItems: 'flex-start' }}><TextButton title={cancelLabel} onPress={onCancel} /></View>
      <Txt weight="600" lines={1} style={{ flexShrink: 1, textAlign: 'center' }}>{title}</Txt>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>{confirm ? <TextButton title={confirm.label} bold onPress={confirm.onPress} disabled={confirm.disabled} busy={confirm.busy} /> : null}</View>
    </View>
  );
}

export function Badge({ label }: { label: string }) {
  const p = usePalette();
  return (
    <View style={[styles.badge, { backgroundColor: p.fill }]}>
      <Text style={{ color: p.secondary, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Txt size={20} weight="600">{title}</Txt>
      {children}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { paddingHorizontal: 16, paddingBottom: 32, gap: 24 },
  button: { minHeight: 50, paddingHorizontal: 20, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  group: { gap: 6 },
  caption: { fontSize: 13, paddingHorizontal: 16 },
  cells: { borderRadius: 12, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  footer: { paddingHorizontal: 16 },
  row: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 12 },
  modalBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 8 },
  badge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start' },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 64, paddingHorizontal: 16 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});
