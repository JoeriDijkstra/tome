import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { navigationTheme } from '@/ui/kit';

export default function RootLayout() {
  const dark = useColorScheme() === 'dark';
  return (
    <ThemeProvider value={navigationTheme(dark ? DarkTheme : DefaultTheme, dark)}>
      <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal', headerShadowVisible: false }}>
        <Stack.Screen name="index" options={{ title: 'Characters', headerLargeTitle: true }} />
        <Stack.Screen name="packs/index" options={{ title: 'Content packs' }} />
        <Stack.Screen name="packs/[id]" options={{ title: 'Pack' }} />
        <Stack.Screen name="c/[id]" options={{ title: '' }} />
      </Stack>
    </ThemeProvider>
  );
}
