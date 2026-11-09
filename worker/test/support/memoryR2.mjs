// In-memory stand-in for a Cloudflare R2 bucket binding (only what files.js uses).
export class MemoryR2 {
  constructor() {
    this.objects = new Map();
    this.counter = 0;
  }

  #meta(key, entry) {
    return {
      key,
      size: entry.bytes.length,
      httpEtag: `"${entry.etag}"`,
      etag: entry.etag,
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
      uploaded: entry.uploaded,
    };
  }

  async put(key, value, { httpMetadata = {}, customMetadata = {} } = {}) {
    const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.counter += 1;
    this.objects.set(key, { bytes, httpMetadata, customMetadata, etag: `etag${this.counter}`, uploaded: new Date() });
    return this.#meta(key, this.objects.get(key));
  }

  async head(key) {
    const entry = this.objects.get(key);
    return entry ? this.#meta(key, entry) : null;
  }

  async get(key, { range } = {}) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    const bytes = range ? entry.bytes.subarray(range.offset, range.offset + range.length) : entry.bytes;
    return { ...this.#meta(key, entry), body: new Blob([bytes]).stream(), range };
  }

  async delete(key) {
    this.objects.delete(key);
  }
}
