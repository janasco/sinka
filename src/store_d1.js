import fs from 'node:fs';
import path from 'node:path';

// D1-backed dedupe store for the container.
// Uses the D1 REST API (works inside Cloudflare Containers and locally),
// falls back to the existing JSON file when D1 env is absent.
//
// Required env (already in .env, no new *_TOKEN keys):
//   CLOUDFLARE_API_TOKEN  (existing)
//   CLOUDFLARE_ACCOUNT_ID
//   D1_DATABASE_ID
// Optional:
//   DATA_DIR (file fallback, default ./data)
//
// Table (see schema.sql):
//   CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, seen_at TEXT NOT NULL DEFAULT ...);

const API = 'https://api.cloudflare.com/client/v4';

async function d1Query({ accountId, databaseId, token, sql, params = [] }) {
  const res = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`D1 query failed: ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(`D1 error: ${JSON.stringify(data.errors)?.slice(0, 300)}`);
  return data.result?.[0]?.results ?? [];
}

export function hasD1Config(env = process.env) {
  return Boolean(
    (env.CLOUDFLARE_API_TOKEN || '').trim() &&
      (env.CLOUDFLARE_ACCOUNT_ID || '').trim() &&
      (env.D1_DATABASE_ID || '').trim()
  );
}

export function createD1Store(env = process.env) {
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const databaseId = (env.D1_DATABASE_ID || '').trim();
  const token = (env.CLOUDFLARE_API_TOKEN || '').trim();
  const cache = new Set();
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const rows = await d1Query({ accountId, databaseId, token, sql: 'SELECT id FROM seen LIMIT 5000' });
      for (const r of rows) if (r?.id) cache.add(String(r.id));
    } catch (err) {
      console.error('[store:d1] load failed, starting empty:', err.message);
    }
    loaded = true;
  }

  return {
    backend: 'd1',
    has: (id) => (id ? cache.has(id) : false),
    add: (id) => {
      if (!id) return;
      if (cache.has(id)) return;
      cache.add(id);
      // Cap memory: keep newest 5000.
      if (cache.size > 6000) {
        const arr = [...cache].slice(-5000);
        cache.clear();
        for (const v of arr) cache.add(v);
      }
      d1Query({
        accountId,
        databaseId,
        token,
        sql: 'INSERT OR IGNORE INTO seen (id) VALUES (?)',
        params: [String(id)],
      }).catch((err) => console.error('[store:d1] save failed:', err.message));
    },
    size: () => cache.size,
    ready: ensureLoaded,
  };
}

// Drop-in replacement for createStore(): D1 when configured, file otherwise.
export function createStoreAuto(dataDir, env = process.env) {
  if (hasD1Config(env)) {
    const s = createD1Store(env);
    // Warm cache in background; polls await ready() before first use.
    s.ready();
    return s;
  }
  const file = path.join(dataDir, 'seen.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let seen = new Set();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) seen = new Set(raw);
    }
  } catch {
    seen = new Set();
  }
  function save() {
    try {
      const arr = [...seen].slice(-5000);
      seen = new Set(arr);
      fs.writeFileSync(file, JSON.stringify(arr));
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }
  return {
    backend: 'file',
    has: (id) => (id ? seen.has(id) : false),
    add: (id) => {
      if (!id) return;
      seen.add(id);
      save();
    },
    size: () => seen.size,
    ready: async () => {},
    file,
  };
}
