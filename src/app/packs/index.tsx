import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import semver from 'semver';

import { data, type InstalledPack } from '@/data';
import { Badge, Button, Card, Empty, Screen, styles, Txt } from '@/ui/kit';
import { usePackImport } from '@/ui/pack-import';

export default function PacksScreen() {
  const [packs, setPacks] = useState<InstalledPack[] | null>(null);
  const load = useCallback(() => { data.packs.list().then(setPacks); }, []);
  useFocusEffect(load);
  const importer = usePackImport(load);

  // one card per pack id, newest version first
  const byId = new Map<string, InstalledPack[]>();
  for (const p of packs ?? []) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
  const groups = [...byId.values()].map((versions) => versions.sort((a, b) => semver.rcompare(a.version, b.version)));

  return (
    <Screen>
      <Button title="Import pack" onPress={importer.start} busy={importer.busy} />
      {packs?.length === 0 ? <Empty title="No content packs installed" /> : null}
      {groups.map(([newest, ...older]) => (
        <Card key={newest.id} onPress={() => router.push({ pathname: '/packs/[id]', params: { id: newest.id } })}>
          <Txt weight="600">{newest.manifest.name}</Txt>
          <View style={styles.row}>
            <Badge label={newest.kind} />
            <Txt muted size={14}>{[newest, ...older].map((p) => p.version).join(', ')}</Txt>
          </View>
          {newest.manifest.extends ? <Txt muted size={13}>{`Adds to ${newest.manifest.extends.id} ${newest.manifest.extends.range}`}</Txt> : null}
        </Card>
      ))}
      {importer.dialog}
    </Screen>
  );
}
