import { Stack } from 'expo-router';

import { stackOptions } from '@/ui/kit';

export default function PacksLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ title: 'Content packs' }} />
      <Stack.Screen name="[id]" options={{ title: 'Pack' }} />
    </Stack>
  );
}
