// The pack import dialog: pick a zip, preview what it is and what it changes, then install or cancel.
// See docs/SPEC.md → Pack import dialog.
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useTheme } from 'expo-router';
import { useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';

import { data, type ImportResult, installPack, type InstallStatus, previewPackZip } from '@/data';
import type { Issue } from '@/engine';

import { AMBER, Badge, Button, Card, styles, Txt } from './kit';

function statusText(s: InstallStatus): string {
  switch (s.kind) {
    case 'new': return 'New pack';
    case 'upgrade': return `Upgrade from ${s.from}`;
    case 'replace': return 'Replaces the installed copy of this version';
    case 'downgrade': return `Older than the installed ${s.from}`;
  }
}

/** `start()` opens the system file picker; `dialog` renders the preview. `onInstalled` runs after a successful install. */
export function usePackImport(onInstalled: () => void) {
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);

  async function start() {
    const picked = await DocumentPicker.getDocumentAsync({ type: ['application/zip', 'application/x-zip-compressed'], copyToCacheDirectory: true });
    if (picked.canceled) return;
    setBusy(true);
    try {
      setResult(await previewPackZip(data, await new File(picked.assets[0].uri).bytes()));
    } catch (e) {
      setResult({ ok: false, issues: [{ level: 'error', at: picked.assets[0].name, message: e instanceof Error ? e.message : String(e) }] });
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    if (!result?.ok) return;
    setInstalling(true);
    try {
      await installPack(data, result.preview);
      setResult(null);
      onInstalled();
    } catch (e) {
      setResult({ ok: false, issues: [{ level: 'error', at: result.preview.manifest.id, message: `install failed: ${e instanceof Error ? e.message : String(e)}` }] });
    } finally {
      setInstalling(false);
    }
  }

  const dialog = (
    <Modal visible={result !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setResult(null)}>
      {result && <Preview result={result} installing={installing} onInstall={install} onCancel={() => setResult(null)} />}
    </Modal>
  );
  return { start, busy, dialog };
}

function Preview({ result, installing, onInstall, onCancel }: { result: ImportResult; installing: boolean; onInstall: () => void; onCancel: () => void }) {
  const { colors } = useTheme();
  if (!result.ok) {
    return (
      <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.screen}>
        <Txt size={22} weight="700">This isn’t a pack Tome can read</Txt>
        <Issues issues={result.issues} />
        <Button title="Close" kind="secondary" onPress={onCancel} />
      </ScrollView>
    );
  }
  const p = result.preview;
  const m = p.manifest;
  const counts = Object.entries(p.counts).map(([label, n]) => `${n} ${label}`).join(' · ');
  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.screen}>
      <Txt size={22} weight="700">{m.name}</Txt>
      <View style={styles.row}>
        <Badge label={m.kind} />
        <Txt muted size={14}>{`${m.id} ${m.version} · schema ${m.schema_version}`}</Txt>
      </View>
      {m.description ? <Txt>{m.description}</Txt> : null}
      <Card>
        <Txt weight="600">{statusText(p.status)}</Txt>
        {m.extends ? (
          <Txt muted size={14}>
            {p.checkedAgainst ? `Adds to ${m.extends.id} ${m.extends.range} (checked against ${p.checkedAgainst})` : `Needs ${m.extends.id} ${m.extends.range}, which isn’t installed`}
          </Txt>
        ) : null}
        {counts ? <Txt muted size={14}>{counts}</Txt> : null}
        {p.affected.length ? <Txt size={14}>{`Changes the rules for: ${p.affected.join(', ')}`}</Txt> : null}
      </Card>
      {m.license ? (
        <Card>
          <Txt weight="600">{`License: ${m.license.name}`}</Txt>
          {m.license.attribution ? <Txt muted size={13}>{m.license.attribution}</Txt> : null}
        </Card>
      ) : null}
      <Issues issues={p.issues} />
      <View style={{ gap: 8 }}>
        <Button title={p.status.kind === 'replace' ? 'Replace' : 'Install'} onPress={onInstall} disabled={!p.canInstall} busy={installing} />
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </ScrollView>
  );
}

function Issues({ issues }: { issues: Issue[] }) {
  const { colors } = useTheme();
  if (!issues.length) return null;
  return (
    <Card>
      {issues.map((i, n) => (
        <View key={n} style={{ gap: 2 }}>
          <Txt size={14} weight="600" color={i.level === 'error' ? colors.notification : AMBER}>{`${i.level === 'error' ? 'Error' : 'Warning'}: ${i.message}`}</Txt>
          <Txt muted size={12}>{i.at}</Txt>
        </View>
      ))}
    </Card>
  );
}
