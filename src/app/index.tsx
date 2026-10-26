import { Stack, useTheme } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

// Character list. Pack import + characters arrive in M2.
export default function CharactersScreen() {
  const { colors } = useTheme();
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Characters' }} />
      <Text style={[styles.text, { color: colors.text }]}>No content packs installed</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: 16, opacity: 0.6 },
});
