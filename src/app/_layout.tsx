import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
        <Stack.Screen name="index" options={{ title: 'Characters' }} />
        <Stack.Screen name="packs/index" options={{ title: 'Content packs' }} />
        <Stack.Screen name="packs/[id]" options={{ title: 'Pack' }} />
        <Stack.Screen name="c/[id]" options={{ title: '' }} />
      </Stack>
    </ThemeProvider>
  );
}
