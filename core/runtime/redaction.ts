/**
 * Replace values of named fields with '[REDACTED]' in a shallow copy.
 *
 * "Shallow" means: nested OBJECTS are not walked — secrets must be at the
 * top level (or one array hop down) of the value you hand in. The
 * redactor does, however, handle two array shapes so list-style action
 * outputs are protected without callers having to flatten:
 *
 *   1. The input itself is an array of records → each record gets shallow
 *      redaction.
 *   2. A top-level field value is an array of records → each element gets
 *      shallow redaction with the same field list.
 *
 * Anything deeper than that — a nested object inside a record, or an
 * array of arrays — is intentionally left alone. Actions that need to
 * protect deeper structures must either flatten them at the top level
 * before returning, or split the secret out into its own action.
 */
export function redactFields(obj: unknown, fields: readonly string[]): unknown {
  if (obj == null || typeof obj !== 'object' || !fields.length) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactFields(item, fields));
  }
  const copy = { ...(obj as Record<string, unknown>) };
  for (const f of fields) {
    if (f in copy) copy[f] = '[REDACTED]';
  }
  // Walk one hop into top-level arrays so e.g. `output.orders[i].card_code`
  // is reached when `card_code` is listed as a sensitive field.
  for (const k of Object.keys(copy)) {
    const v = copy[k];
    if (Array.isArray(v)) {
      copy[k] = v.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item) ? redactFields(item, fields) : item,
      );
    }
  }
  return copy;
}
