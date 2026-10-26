// Hermes (React Native) has no built-in structured clone. Pack and character data is plain JSON, so a structural
// copy of arrays and plain objects is enough; anything else (FormulaValue, primitives) is shared as is.
export function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out as T;
  }
  return value;
}
