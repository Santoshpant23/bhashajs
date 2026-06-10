const MAX_DEPTH = 8;
const MAX_FLAT_KEYS = 10000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function flattenTranslations(input: unknown): {
  flat: Record<string, string>;
  skipped: string[];
} {
  const flat: Record<string, string> = Object.create(null);
  const skipped: string[] = [];

  function add(path: string, value: string) {
    if (Object.keys(flat).length >= MAX_FLAT_KEYS) {
      throw new Error("Too many keys in one import");
    }
    flat[path] = value;
  }

  function walk(value: unknown, path: string[]) {
    if (!isPlainObject(value)) {
      if (path.length > 0) skipped.push(path.join("."));
      return;
    }

    for (const [segment, child] of Object.entries(value)) {
      const nextPath = [...path, segment];
      const dotted = nextPath.join(".");
      if (nextPath.length > MAX_DEPTH) {
        skipped.push(dotted);
        continue;
      }

      if (typeof child === "string") {
        add(dotted, child);
      } else if (isPlainObject(child)) {
        walk(child, nextPath);
      } else {
        skipped.push(dotted);
      }
    }
  }

  walk(input, []);
  return { flat, skipped };
}
