// In-memory Cloudflare KV stand-in (get/put/delete/list with expiry) for tests.
export function createMemoryKV(clock = () => Date.now()) {
  const store = new Map(); // key -> { value, expiresAt, metadata }
  const live = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= clock()) {
      store.delete(key);
      return null;
    }
    return entry;
  };
  return {
    store,
    async get(key, options) {
      const entry = live(key);
      if (!entry) return null;
      const type = typeof options === "string" ? options : options?.type;
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    },
    async put(key, value, options = {}) {
      const expiresAt = options.expirationTtl ? clock() + options.expirationTtl * 1000 : options.expiration ? options.expiration * 1000 : null;
      store.set(key, { value: typeof value === "string" ? value : String(value), expiresAt, metadata: options.metadata ?? null });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix) && live(k)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return {
        keys: page.map((name) => ({ name, ...(store.get(name).expiresAt ? { expiration: Math.floor(store.get(name).expiresAt / 1000) } : {}), ...(store.get(name).metadata ? { metadata: store.get(name).metadata } : {}) })),
        list_complete: done,
        ...(done ? {} : { cursor: String(start + limit) }),
      };
    },
  };
}
