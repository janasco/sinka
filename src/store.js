import fs from 'node:fs';
import path from 'node:path';

// Persistent dedupe store: remembers Message-IDs already replicated
// so restarts / re-polls never double-send. Backed by a small JSON file.
export function createStore(dataDir) {
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
      // Cap growth: keep only the newest 5000 ids.
      const arr = [...seen].slice(-5000);
      seen = new Set(arr);
      fs.writeFileSync(file, JSON.stringify(arr));
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }

  return {
    has: (id) => (id ? seen.has(id) : false),
    add: (id) => {
      if (!id) return;
      seen.add(id);
      save();
    },
    size: () => seen.size,
    file,
  };
}
