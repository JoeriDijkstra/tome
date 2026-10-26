// The one place that picks the storage backend. A server adapter replaces this line.
export { sqliteAdapter as data } from './sqlite';
export * from './adapter';
export * from './characters';
export * from './packs';
