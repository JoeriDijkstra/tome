import { Link, Stack, useFocusEffect, useTheme } from 'expo-router';
import { useCallback, useState } from 'react';
import { SymbolView } from 'expo-symbols';
import { Pressable } from 'react-native';

import { type CharacterSummary, data, type InstalledPack } from '@/data';
import { Button, Card, Empty, Screen, Txt } from '@/ui/kit';
import { usePackImport } from '@/ui/pack-import';

export default function CharactersScreen() {
  const { colors } = useTheme();
  const [packs, setPacks] = useState<InstalledPack[] | null>(null);
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const load = useCallback(() => {
    Promise.all([data.packs.list(), data.characters.list()]).then(([p, c]) => {
      setPacks(p);
      setCharacters(c);
    });
  }, []);
  useFocusEffect(load);
  const importer = usePackImport(load);

  return (
    <Screen>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/packs" asChild>
              <Pressable accessibilityRole="link" accessibilityLabel="Content packs" hitSlop={8}>
                <SymbolView name={{ ios: 'shippingbox', android: 'inventory_2' }} size={22} tintColor={colors.primary} />
              </Pressable>
            </Link>
          ),
        }}
      />
      {packs === null ? null : packs.length === 0 ? (
        <Empty title="No content packs installed">
          <Txt muted style={{ textAlign: 'center' }}>Tome ships without game content. Import a pack to get started.</Txt>
          <Button title="Import pack" onPress={importer.start} busy={importer.busy} />
        </Empty>
      ) : characters.length === 0 ? (
        <Empty title="No characters yet">
          <Txt muted>{`${packs.length} content pack${packs.length === 1 ? '' : 's'} installed.`}</Txt>
        </Empty>
      ) : (
        characters.map((c) => (
          <Card key={c.id}>
            <Txt weight="600">{c.name}</Txt>
            <Txt muted size={13}>{c.packs.major.id}</Txt>
          </Card>
        ))
      )}
      {importer.dialog}
    </Screen>
  );
}
