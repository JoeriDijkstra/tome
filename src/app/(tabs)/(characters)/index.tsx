import { MenuView } from '@expo/ui/community/menu';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';

import { type CharacterSummary, data, importCharacterFile, type InstalledPack } from '@/data';
import { Button, Empty, Group, Icon, Row, Screen, TextButton, Txt } from '@/ui/kit';
import { usePackImport } from '@/ui/pack-import';

/** Pick a `.tome.json` file and store it as a new character, then open it. */
async function importCharacter() {
  const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'public.json'], copyToCacheDirectory: true });
  if (picked.canceled) return;
  const r = await importCharacterFile(data, await new File(picked.assets[0].uri).text());
  if (!r.ok) return Alert.alert('Can’t import this file', r.error);
  router.push({ pathname: '/c/[id]', params: { id: r.doc.id } });
}

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
        options={{
          headerRight: () => (
            <MenuView
              actions={[
                { id: 'new', title: 'New character', image: 'person.badge.plus', attributes: { disabled: !canCreate } },
                { id: 'import', title: 'Import character', image: 'square.and.arrow.down' },
              ]}
              onPressAction={({ nativeEvent }) => (nativeEvent.event === 'new' ? router.push('/new') : void importCharacter())}>
              <View accessibilityRole="button" accessibilityLabel="Add character"><Icon name="plus" android="add" size={22} /></View>
            </MenuView>
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
          {canCreate ? <Button title="New character" onPress={() => router.push('/new')} /> : null}
          <TextButton title="Import character" onPress={() => void importCharacter()} />
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
