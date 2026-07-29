// Downloads a (large) model file and caches it in the browser's Cache
// Storage so repeat visits don't re-download hundreds of MB. Reports
// download progress via a callback since these files can be 100-300MB.

const MODEL_CACHE_NAME = 'stems-model-cache-v1';

async function fetchWithProgress(url, onProgress) {
  const cache = ('caches' in window) ? await caches.open(MODEL_CACHE_NAME) : null;

  if (cache) {
    const cached = await cache.match(url);
    if (cached) {
      const buf = await cached.arrayBuffer();
      if (onProgress) onProgress(buf.byteLength, buf.byteLength);
      return buf;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;

  if (cache) {
    // Stash the response in the cache while streaming a progress-tracked
    // copy back to the caller, so future loads skip the network entirely.
    await cache.put(url, response.clone());
  }

  if (!response.body) {
    // Environments without ReadableStream support: fall back to a plain
    // arrayBuffer() with no incremental progress.
    const buf = await response.arrayBuffer();
    if (onProgress) onProgress(buf.byteLength, buf.byteLength || total);
    return buf;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }

  const combined = new Uint8Array(received);
  let pos = 0;
  for (const chunk of chunks) {
    combined.set(chunk, pos);
    pos += chunk.length;
  }
  return combined.buffer;
}

async function clearModelCache() {
  if ('caches' in window) {
    await caches.delete(MODEL_CACHE_NAME);
  }
}
