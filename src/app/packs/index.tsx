import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import semver from 'semver';

import { data, type InstalledPack } from '@/data';
import { Badge, Empty, Group, IconButton, Row, Screen, styles, Txt } from '@/ui/kit';
import { usePackImport } from '@/ui/pack-import';

export default function PacksScreen() {
  const [packs, setPacks] = useState<InstalledPack[] | null>(null);
  const load = useCallback(() => { data.packs.list().then(setPacks); }, []);
  useFocusEffect(load);
  const importer = usePackImport(load);

  // one row per pack id, newest version first
  const byId = new Map<string, InstalledPack[]>();
  for (const p of packs ?? []) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
  const groups = [...byId.values()].map((versions) => versions.sort((a, b) => semver.rcompare(a.version, b.version)));
  const majors = groups.filter(([p]) => p.kind === 'major');
  const expansions = groups.filter(([p]) => p.kind === 'expansion');

  const row = ([newest, ...older]: InstalledPack[]) => (
    <Row
      key={newest.id}
      label={newest.manifest.name}
      chevron
      onPress={() => router.push({ pathname: '/packs/[id]', params: { id: newest.id } })}
      title={newest.manifest.name}
      subtitle={
        <View style={styles.inline}>
          <Txt muted size={15}>{[newest, ...older].map((p) => p.version).join(', ')}</Txt>
          {newest.manifest.extends ? <Badge label={`adds to ${newest.manifest.extends.id}`} /> : null}
        </View>
      }
    />
  );

  return (
    <Screen>
      <Stack.Screen
        options={{
          headerRight: () => (importer.busy ? <ActivityIndicator /> : <IconButton name="plus" android="add" label="Import pack" onPress={importer.start} />),
        }}
      />
      {packs?.length === 0 ? <Empty title="No content packs installed"><Txt muted>Tap + to import a pack.</Txt></Empty> : null}
      {majors.length ? <Group header="Game systems">{majors.map(row)}</Group> : null}
      {expansions.length ? <Group header="Expansions">{expansions.map(row)}</Group> : null}
      {importer.dialog}
    </Screen>
  );
}
