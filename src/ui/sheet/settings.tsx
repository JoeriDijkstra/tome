// Character settings: name, expansions, export, delete. Shown over the sheet, and every change goes
// through the sheet's session, so the open character is never written by two hands at once.
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, Switch, TextInput, View } from 'react-native';
import semver from 'semver';

import { type Character, characterFile, characterFileName, data, type InstalledPack, loadPackSet, newestVersions } from '@/data';
import { type CharacterPins, resolvePins } from '@/engine';
import { Group, ModalBar, Row, styles, TextButton, Txt, usePalette } from '@/ui/kit';

export function CharacterSettings({ doc, edit, onClose, onPinsChanged, onDelete }: {
  doc: Character;
  edit: (change: (current: Character) => Character) => Promise<void>;
  onClose: () => void;
  onPinsChanged: (pins: CharacterPins) => void;
  onDelete: () => void;
}) {
  const p = usePalette();
  const [name, setName] = useState(doc.name);
  const [installed, setInstalled] = useState<InstalledPack[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void data.packs.list().then(setInstalled); }, []);

  // a rename is kept whether the player presses Return or just closes
  const commitName = () => {
    const n = name.trim();
    if (n && n !== doc.name) void edit((d) => ({ ...d, name: n }));
    else setName(doc.name);
  };
  const close = () => {
    commitName();
    onClose();
  };

  const resolved = resolvePins(doc.packs, installed).resolved;
  const majorVersion = resolved.find((r) => r.id === doc.packs.major.id)?.version;
  const latest = newestVersions(installed);
  const majorName = latest.find((x) => x.id === doc.packs.major.id)?.manifest.name ?? doc.packs.major.id;
  // expansions that fit this character's major, plus any it pins that aren't installed any more
  const fitting = latest.filter((x) => x.manifest.extends?.id === doc.packs.major.id && majorVersion && semver.satisfies(majorVersion, x.manifest.extends.range));
  const expansionIds = [...new Set([...fitting.map((x) => x.id), ...doc.packs.expansions.map((e) => e.id)])];

  const toggleExpansion = async (expId: string, on: boolean) => {
    const pack = fitting.find((x) => x.id === expId);
    const expansions = on && pack ? [...doc.packs.expansions, { id: expId, range: `^${pack.version}` }] : doc.packs.expansions.filter((e) => e.id !== expId);
    const pins = { ...doc.packs, expansions };
    setBusy(true);
    const set = await loadPackSet(data, pins);
    setBusy(false);
    // removing a missing expansion is always allowed: it can only make the character openable again
    if (!set.ok && on) return Alert.alert('Can’t add this expansion', [...set.missing.map((m) => `Missing ${m.id} ${m.range}`), ...set.issues.filter((i) => i.level === 'error').map((i) => i.message)].join('\n'));
    await edit((d) => ({ ...d, packs: pins }));
    onPinsChanged(pins);
  };

  const exportFile = async () => {
    const file = new File(Paths.cache, characterFileName(doc));
    if (file.exists) file.delete();
    file.create();
    file.write(characterFile(doc, resolved));
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: `Export ${doc.name}` });
  };

  const remove = () => Alert.alert(`Delete ${doc.name}?`, 'This can’t be undone. Export the character first to keep a copy.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onDelete },
  ]);

  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <ModalBar title="Character settings" onCancel={close} cancelLabel="Done" />
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <Group header="Name">
          <Row>
            <TextInput accessibilityLabel="Name" value={name} onChangeText={setName} placeholder="Character name" placeholderTextColor={p.secondary}
              returnKeyType="done" onSubmitEditing={commitName} style={{ color: p.text, fontSize: 17 }} />
          </Row>
        </Group>
        <Group header="Game system" footer="A character keeps its game system. Install a newer version of the pack to update the rules.">
          <Row title={majorName} trailing={<Txt muted>{majorVersion ?? `missing ${doc.packs.major.range}`}</Txt>} />
        </Group>
        {expansionIds.length ? (
          <Group header="Expansions">
            {expansionIds.map((e) => {
              const pin = doc.packs.expansions.find((x) => x.id === e);
              const pack = fitting.find((x) => x.id === e);
              return (
                <Row key={e} title={pack?.manifest.name ?? e} subtitle={pack ? pack.version : `missing ${pin?.range}`}
                  trailing={<Switch accessibilityLabel={pack?.manifest.name ?? e} value={pin !== undefined} disabled={busy || (!pack && !pin)} onValueChange={(on) => void toggleExpansion(e, on)} />} />
              );
            })}
          </Group>
        ) : null}
        <Group footer="Saves the character, notes included, as a file you can share or import on another device.">
          <Row title={<TextButton title="Export character" onPress={() => void exportFile()} />} />
        </Group>
        <Group>
          <Row title={<TextButton title="Delete character" danger onPress={remove} />} />
        </Group>
      </ScrollView>
    </View>
  );
}
