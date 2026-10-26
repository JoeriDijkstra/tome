// What every sheet widget needs: the evaluated character and a way to change it.
import { createContext, useContext } from 'react';

import type { Note } from '@/data';
import type { Compiled, View } from '@/engine';
import type { Effect } from '@/engine/schema';

export interface SheetCtx {
  compiled: Compiled;
  view: View;
  /** missing packs or a conflict: nothing can be changed */
  readonly: boolean;
  /** run a pack action; `vars` carry a list row's $v/$k */
  action(id: string, vars?: Record<string, unknown>): Promise<void>;
  /** run app-generated effects (resource ±, toggles, field edits) */
  effects(effects: Effect[], vars?: Record<string, unknown>): Promise<void>;
  /** show where a modified value comes from */
  explain(path: string, label: string): void;
  /** show an entity's or feature's prose */
  detail(title: string, body: string): void;
  /** show a pack tab as a page over the sheet */
  open(tabId: string): void;
  /** the character's journal; lives on the document, outside the rules and undo */
  notes: Note[];
  editNotes(change: (notes: Note[]) => Note[]): Promise<void>;
}

export const SheetContext = createContext<SheetCtx | null>(null);

export function useSheet(): SheetCtx {
  const ctx = useContext(SheetContext);
  if (!ctx) throw new Error('useSheet outside a sheet');
  return ctx;
}
