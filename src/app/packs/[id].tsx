import { strFromU8 } from 'fflate';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import semver from 'semver';

import { data, type InstalledPack, uninstallBlockers, uninstallPack } from '@/data';
import { Badge, Button, Card, Screen, styles, Txt } from '@/ui/kit';

export default function PackScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [versions, setVersions] = useState<InstalledPack[]>([]);
  const [license, setLicense] = useState<string | null>(null);

  const load = useCallback(() => {
    data.packs.list().then(async (all) => {
      const mine = all.filter((p) => p.id === id).sort((a, b) => semver.rcompare(a.version, b.version));
      setVersions(mine);
      const newest = mine[0];
      if (!newest) return;
      const files = await data.packs.files(newest.id, newest.version);
      setLicense(files.includes('LICENSE.md') ? strFromU8(await data.packs.readFile(newest.id, newest.version, 'LICENSE.md')) : null);
    });
  }, [id]);
  useFocusEffect(load);

  async function remove(p: InstalledPack) {
    const blockers = await uninstallBlockers(data, p.id, p.version);
    if (blockers.length) {
      Alert.alert('Still in use', `${blockers.join(', ')} ${blockers.length === 1 ? 'needs' : 'need'} ${p.id} ${p.version}. Install another matching version or change those characters first.`);
      return;
    }
    Alert.alert(`Remove ${p.manifest.name} ${p.version}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await uninstallPack(data, p.id, p.version);
          if (versions.length === 1) router.back();
          else load();
        },
      },
    ]);
  }

  const m = versions[0]?.manifest;
  if (!m) return null;
  return (
    <Screen>
      <Stack.Screen options={{ title: m.name }} />
      <View style={styles.row}>
        <Badge label={m.kind} />
        <Txt muted size={14}>{`${m.id} · schema ${m.schema_version}${m.author ? ` · ${m.author}` : ''}`}</Txt>
      </View>
      {m.description ? <Txt>{m.description}</Txt> : null}
      {m.extends ? <Txt muted>{`Adds to ${m.extends.id} ${m.extends.range}`}</Txt> : null}
      <Txt weight="600">Installed versions</Txt>
      {versions.map((p) => (
        <Card key={p.version}>
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Txt>{p.version}</Txt>
            <Button title="Remove" kind="danger" onPress={() => remove(p)} />
          </View>
        </Card>
      ))}
      {m.license ? (
        <Card>
          <Txt weight="600">{`License: ${m.license.name}`}</Txt>
          {m.license.attribution ? <Txt muted size={13}>{m.license.attribution}</Txt> : null}
        </Card>
      ) : null}
      {license ? (
        <Card>
          <Txt size={13}>{license}</Txt>
        </Card>
      ) : null}
    </Screen>
  );
}
