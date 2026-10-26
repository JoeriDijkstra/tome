// One open character: writes run one at a time against the newest saved doc, so quick taps never
// race on a stale rev. Holds the in-memory undo stack (cleared when the sheet closes).
import { Alert } from 'react-native';

import { type Character, ConflictError, data } from '@/data';
import type { RunResult, State } from '@/engine';

const UNDO_DEPTH = 20;

export class SheetSession {
  private latest: Character | null = null;
  private undoStack: State[] = [];
  private queue: Promise<void> = Promise.resolve();

  /** `onChange` receives every saved (or reloaded) doc and the undo depth. */
  constructor(private onChange: (doc: Character | null, undoDepth: number) => void) {}

  loaded(doc: Character | null) {
    this.latest = doc;
    this.onChange(doc, this.undoStack.length);
  }

  write(job: (current: Character) => Promise<RunResult>, recordUndo = true): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const prev = this.latest;
        if (!prev) return;
        const result = await job(prev);
        if (!result.ok) {
          if ('rejected' in result) Alert.alert('That didn’t work', result.rejected);
          return;
        }
        try {
          const saved = await data.characters.put({ ...prev, state: result.state }, prev.rev);
          if (recordUndo) this.undoStack = [...this.undoStack, prev.state].slice(-UNDO_DEPTH);
          this.loaded(saved);
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          Alert.alert('Changed elsewhere', 'This character was changed somewhere else. Reloading.');
          this.undoStack = [];
          this.loaded(await data.characters.get(prev.id));
        }
      })
      // keep the queue alive after an unexpected failure
      .catch((e: unknown) => Alert.alert('Something went wrong', e instanceof Error ? e.message : String(e)));
    return this.queue;
  }

  undo(): Promise<void> {
    return this.write(async () => {
      const prev = this.undoStack.pop();
      return prev === undefined ? { ok: false, cancelled: true } : { ok: true, state: prev, answers: [] };
    }, false);
  }
}
