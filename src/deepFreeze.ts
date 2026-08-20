/** Recursively freeze an acyclic JSON-like value through its enumerable
 * object properties. Deliberately does not add cycle or Map/Set handling. */
export function deepFreezeJsonLike<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeJsonLike(child);
    }
    Object.freeze(value);
  }
  return value;
}
