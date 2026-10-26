import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { type CharacterSummary, data, type InstalledPack } from '@/data';
import { Button, Empty, Group, IconButton, Row, Screen, Txt } from '@/ui/kit';
import { usePackImport } from '@/ui/pack-import';

export default function CharactersScreen() {
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
  const packName = (id: string) => packs?.find((p) => p.id === id)?.manifest.name ?? id;
  const canCreate = packs?.some((p) => p.kind === 'major') ?? false;

  return (
    <Screen>
      <Stack.Screen
        options={{ headerRight: () => (canCreate ? <IconButton name="plus" android="add" label="New character" onPress={() => router.push('/new')} /> : null) }}
      />
      {packs === null ? null : packs.length === 0 ? (
        <Empty title="No content packs installed">
          <Txt muted style={{ textAlign: 'center' }}>Tome ships without game content. Import a pack to get started.</Txt>
          <Button title="Import pack" onPress={importer.start} busy={importer.busy} />
        </Empty>
      ) : characters.length === 0 ? (
        <Empty title="No characters yet">
          <Txt muted>{`${packs.length} content pack${packs.length === 1 ? '' : 's'} installed.`}</Txt>
          {canCreate ? <Button title="New character" onPress={() => router.push('/new')} /> : null}
        </Empty>
      ) : (
        <Group>
          {characters.map((c) => (
            <Row key={c.id} title={c.name} subtitle={packName(c.packs.major.id)} chevron label={c.name} onPress={() => router.push({ pathname: '/c/[id]', params: { id: c.id } })} />
          ))}
        </Group>
      )}
      {importer.dialog}
    </Screen>
  );
}
