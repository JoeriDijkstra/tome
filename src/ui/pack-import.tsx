// The pack import dialog: pick a zip, preview what it is and what it changes, then install or cancel.
// See docs/SPEC.md → Pack import dialog.
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';

import { data, type ImportResult, installPack, type InstallStatus, previewPackZip } from '@/data';
import type { Issue } from '@/engine';

import { Group, ModalBar, Row, styles, Txt, usePalette } from './kit';

function statusText(s: InstallStatus): string {
  switch (s.kind) {
    case 'new': return 'New pack';
    case 'upgrade': return `Upgrade from ${s.from}`;
    case 'replace': return 'Replaces the installed copy';
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
  const p = usePalette();
  if (!result.ok) {
    return (
      <View style={{ flex: 1, backgroundColor: p.background }}>
        <ModalBar title="Can’t import" onCancel={onCancel} />
        <ScrollView contentContainerStyle={styles.screen}>
          <Txt muted>This isn’t a pack Tome can read.</Txt>
          <Issues issues={result.issues} />
        </ScrollView>
      </View>
    );
  }
  const pv = result.preview;
  const m = pv.manifest;
  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <ModalBar title={m.name} onCancel={onCancel} confirm={{ label: pv.status.kind === 'replace' ? 'Replace' : 'Install', onPress: onInstall, disabled: !pv.canInstall, busy: installing }} />
      <ScrollView contentContainerStyle={styles.screen}>
        <Group footer={m.description}>
          <Row title={statusText(pv.status)} trailing={<Txt muted>{m.version}</Txt>} />
          <Row title="Kind" trailing={<Txt muted>{m.kind === 'major' ? 'Game system' : 'Expansion'}</Txt>} />
          {m.extends ? (
            <Row title={`Adds to ${m.extends.id} ${m.extends.range}`} subtitle={pv.checkedAgainst ? `Checked against ${pv.checkedAgainst}` : 'Not installed yet'} />
          ) : null}
          <Row title="Format" trailing={<Txt muted>{`schema ${m.schema_version}`}</Txt>} />
        </Group>
        {Object.keys(pv.counts).length ? (
          <Group header="Contents">
            {Object.entries(pv.counts).map(([label, n]) => <Row key={label} title={label} trailing={<Txt muted>{String(n)}</Txt>} />)}
          </Group>
        ) : null}
        {pv.affected.length ? <Group header="Changes the rules for">{pv.affected.map((n) => <Row key={n} title={n} />)}</Group> : null}
        {m.license ? <Group header="License" footer={m.license.attribution}><Row title={m.license.name} /></Group> : null}
        <Issues issues={pv.issues} />
      </ScrollView>
    </View>
  );
}

function Issues({ issues }: { issues: Issue[] }) {
  const p = usePalette();
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.level === 'error').length;
  return (
    <Group header={errors ? `${errors} error${errors === 1 ? '' : 's'}` : 'Warnings'}>
      {issues.map((i, n) => (
        <Row key={n} title={<Txt size={15} color={i.level === 'error' ? p.danger : p.warning}>{i.message}</Txt>} subtitle={<Txt muted size={12}>{i.at}</Txt>} />
      ))}
    </Group>
  );
}
