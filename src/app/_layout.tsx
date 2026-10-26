import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { navigationTheme, stackOptions } from '@/ui/kit';

/** Tabs at the root; a character sheet and the creation wizard cover them. */
export default function RootLayout() {
  const dark = useColorScheme() === 'dark';
  return (
    <ThemeProvider value={navigationTheme(dark ? DarkTheme : DefaultTheme, dark)}>
      <Stack screenOptions={stackOptions}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="c/[id]" options={{ title: '' }} />
        <Stack.Screen name="new" options={{ title: 'New character' }} />
      </Stack>
    </ThemeProvider>
  );
}
