// The `notes` widget: the character's journal. Notes are the player's, not the rules', so they live
// on the document beside `state` and never go through the engine or undo. Bodies are markdown.
import { useRef, useState } from 'react';
import { Alert, Modal, ScrollView, TextInput, View } from 'react-native';
import { EnrichedMarkdownTextInput } from 'react-native-enriched-markdown';

import { newId, type Note } from '@/data';
import { Group, Icon, markdownStyle, ModalBar, Row, styles, TextButton, Txt, usePalette } from '@/ui/kit';

import { useSheet } from './context';

/** first line of the body without markdown markers, for the row subtitle */
const preview = (body: string) => body.split('\n').map((l) => l.replace(/^[#>\-*+\d.)\s]+/, '').replace(/[*_~`]/g, '').trim()).find((l) => l) ?? '';

/** every word of the query appears in the title or body, ignoring case and accents */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const matches = (note: Note, query: string) => {
  const text = fold(`${note.title}\n${note.body}`);
  return fold(query).split(/\s+/).filter(Boolean).every((w) => text.includes(w));
};

export function Notes() {
  const { notes, editNotes, readonly } = useSheet();
  const p = usePalette();
  const [open, setOpen] = useState<Note | null>(null);
  const [query, setQuery] = useState('');
  const sorted = [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const shown = query.trim() ? sorted.filter((n) => matches(n, query)) : sorted;
  const footer = query.trim() && shown.length === 0 ? `No notes match “${query.trim()}”.` : 'Kept with this character and included when you export it.';

  const save = (note: Note) => {
    setOpen(null);
    const empty = note.title.trim() === '' && note.body.trim() === '';
    void editNotes((all) => {
      const rest = all.filter((n) => n.id !== note.id);
      return empty ? rest : [...rest, { ...note, updated_at: new Date().toISOString() }];
    });
  };
  const remove = (note: Note) => {
    setOpen(null);
    void editNotes((all) => all.filter((n) => n.id !== note.id));
  };

  return (
    <>
      {notes.length ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: p.fill, borderRadius: 10, paddingHorizontal: 8, height: 36 }}>
          <Icon name="magnifyingglass" android="search" size={16} color={p.secondary} />
          <TextInput accessibilityLabel="Search notes" value={query} onChangeText={setQuery} placeholder="Search notes" placeholderTextColor={p.secondary}
            returnKeyType="search" autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" style={{ flex: 1, color: p.text, fontSize: 17 }} />
        </View>
      ) : null}
      <Group header="Notes" footer={footer}>
        {shown.map((n) => (
          <Row key={n.id} label={n.title || 'Untitled'} title={n.title || 'Untitled'} chevron onPress={() => setOpen(n)}
            subtitle={<Txt muted size={15} lines={2}>{[new Date(n.updated_at).toLocaleDateString(), preview(n.body)].filter(Boolean).join('  ·  ')}</Txt>} />
        ))}
        {readonly ? null : (
          <Row key="add" label="New note" onPress={() => setOpen({ id: newId(), title: '', body: '', updated_at: '' })} title={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="plus.circle.fill" android="add_circle" size={20} />
              <Txt color={p.tint}>New note</Txt>
            </View>
          } />
        )}
      </Group>
      <Modal visible={open !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (open) save(open); }}>
        {open ? <NoteEditor note={open} readonly={readonly} onDone={save} onDelete={notes.some((n) => n.id === open.id) ? remove : undefined} /> : null}
      </Modal>
    </>
  );
}

function NoteEditor({ note, readonly, onDone, onDelete }: { note: Note; readonly: boolean; onDone: (n: Note) => void; onDelete?: (n: Note) => void }) {
  const p = usePalette();
  const [title, setTitle] = useState(note.title);
  // the editor is uncontrolled; keep its latest markdown without re-rendering on every keystroke
  const body = useRef(note.body);
  const done = () => onDone({ ...note, title: title.trim(), body: body.current });
  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <ModalBar title={note.title ? 'Note' : 'New note'} onCancel={done} cancelLabel="Done" />
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <Group>
          <Row>
            <TextInput accessibilityLabel="Title" value={title} onChangeText={setTitle} editable={!readonly} placeholder="Title" placeholderTextColor={p.secondary}
              style={{ color: p.text, fontSize: 17, fontWeight: '600' }} />
          </Row>
        </Group>
        <Group footer="Select text for bold, italic and links. Start a line with “# ” for a heading or “- ” for a list.">
          <Row>
            <EnrichedMarkdownTextInput defaultValue={note.body} onChangeMarkdown={(md) => { body.current = md; }} editable={!readonly}
              autoFocus={note.body === '' && note.title !== ''} placeholder="Write anything…" placeholderTextColor={p.secondary} markdownShortcuts
              markdownStyle={markdownStyle(p)} style={{ color: p.text, fontSize: 17, minHeight: 280 }} accessibilityLabel="Note" />
          </Row>
        </Group>
        {onDelete && !readonly ? (
          <Group>
            <Row title={<TextButton title="Delete note" danger onPress={() => Alert.alert('Delete this note?', undefined, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => onDelete(note) },
            ])} />} />
          </Group>
        ) : null}
      </ScrollView>
    </View>
  );
}
