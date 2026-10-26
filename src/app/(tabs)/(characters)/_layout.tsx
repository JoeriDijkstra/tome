import { Stack } from 'expo-router';

import { stackOptions } from '@/ui/kit';

export default function CharactersLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ title: 'Characters' }} />
    </Stack>
  );
}
