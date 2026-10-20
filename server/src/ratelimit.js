// Fixed-window counter per key, swept once per window.
export function createRateLimiter({ limit, windowMs = 60_000 }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    take(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.reset <= now) {
        entry = { count: 0, reset: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return { ok: entry.count <= limit, retryAfter: Math.ceil((entry.reset - now) / 1000) };
    },
    close() {
      clearInterval(sweep);
    },
  };
}
