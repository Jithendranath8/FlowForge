/*
 * Request values PostgreSQL cannot store are the client's mistake and are refused with a
 * 400 before any handler runs. A NUL character is one: text and jsonb both reject it.
 * Left to the database it surfaces as a 500, which workers retry: a handler whose
 * output contained a NUL was re-run until its retries ran out.
 */

function badText(s: string): string | null {
  if (s.includes("\u0000")) return "a NUL character (\\u0000)";
  return null;
}

/**
 * The first problem in a parsed request value, as a sentence fragment naming where it is
 * (`body.input.items[1].note contains …`), or null. Iterative, because the depth of the
 * value is chosen by the client.
 */
export function findUnstorable(root: unknown, label: string): string | null {
  const stack: { value: unknown; path: string }[] = [{ value: root, path: label }];
  for (let item = stack.pop(); item; item = stack.pop()) {
    const { value, path } = item;
    if (typeof value === "string") {
      const why = badText(value);
      if (why) return `${path} contains ${why}`;
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    // Pushed in reverse so values are visited in document order.
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], path: `${path}[${i}]` });
      continue;
    }
    const entries = Object.entries(value);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [k, v] = entries[i]!;
      const why = badText(k);
      if (why) return `a key of ${path} contains ${why}`;
      stack.push({ value: v, path: `${path}.${k}` });
    }
  }
  return null;
}
