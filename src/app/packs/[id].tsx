import { strFromU8 } from 'fflate';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import semver from 'semver';

import { data, type InstalledPack, uninstallBlockers, uninstallPack } from '@/data';
import { Group, Row, Screen, TextButton, Txt } from '@/ui/kit';

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
      <Group footer={m.description}>
        <Row title="Identifier" trailing={<Txt muted>{m.id}</Txt>} />
        <Row title="Kind" trailing={<Txt muted>{m.kind === 'major' ? 'Game system' : `Adds to ${m.extends?.id} ${m.extends?.range}`}</Txt>} />
        {m.author ? <Row title="Author" trailing={<Txt muted>{m.author}</Txt>} /> : null}
        <Row title="Format" trailing={<Txt muted>{`schema ${m.schema_version}`}</Txt>} />
      </Group>
      <Group header="Installed versions">
        {versions.map((p) => (
          <Row key={p.version} title={p.version} trailing={<TextButton title="Remove" danger onPress={() => remove(p)} />} />
        ))}
      </Group>
      {m.license ? (
        <Group header="License" footer={m.license.attribution}>
          <Row title={m.license.name} />
        </Group>
      ) : null}
      {license ? (
        <Group>
          <Row><Txt size={15}>{license}</Txt></Row>
        </Group>
      ) : null}
    </Screen>
  );
}
