// App-owned building blocks (lists, pack manager). In-sheet UI comes from packs and lands in M3.
import { useTheme } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, type ColorValue, Pressable, ScrollView, StyleSheet, Text, type TextStyle, View } from 'react-native';

export const AMBER = '#b7791f';

export function Txt({ children, muted, size = 16, weight, color, style }: { children: ReactNode; muted?: boolean; size?: number; weight?: TextStyle['fontWeight']; color?: ColorValue; style?: TextStyle }) {
  const { colors } = useTheme();
  return <Text style={[{ color: color ?? colors.text, fontSize: size, fontWeight: weight, opacity: muted ? 0.6 : 1 }, style]}>{children}</Text>;
}

export function Button({ title, onPress, disabled, busy, kind = 'primary' }: { title: string; onPress: () => void; disabled?: boolean; busy?: boolean; kind?: 'primary' | 'secondary' | 'danger' }) {
  const { colors } = useTheme();
  const bg = kind === 'primary' ? colors.primary : kind === 'danger' ? colors.notification : 'transparent';
  const fg = kind === 'secondary' ? colors.primary : '#fff';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, borderColor: colors.primary, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }, kind === 'secondary' && styles.outline]}>
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  return <ScrollView contentContainerStyle={styles.screen} contentInsetAdjustmentBehavior="automatic">{children}</ScrollView>;
}

export function Card({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  const { colors } = useTheme();
  const style = [styles.card, { backgroundColor: colors.card, borderColor: colors.border }];
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [...style, { opacity: pressed ? 0.7 : 1 }]}>{children}</Pressable>
  ) : (
    <View style={style}>{children}</View>
  );
}

export function Badge({ label, color }: { label: string; color?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.badge, { borderColor: color ?? colors.border }]}>
      <Text style={{ color: color ?? colors.text, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Txt size={18} weight="600">{title}</Txt>
      {children}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { padding: 16, gap: 12 },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  outline: { borderWidth: 1 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 6 },
  badge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, alignSelf: 'flex-start' },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 48 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});
