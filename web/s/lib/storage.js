// JSON values in localStorage. Never throws: with storage blocked they last until a reload, in
// memory. When it is full, the keys `cached` picks go first, since they can be fetched again; set()
// returns false if the value still can't be saved.
//
// That can take the current tournament's offline copy too, and a reload offline then waits for the
// network. Accepted (user decision, 2026-10-31): it needs about 5 MB of text, and marks stay safe.

function memoryStore() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function localStore() {
  try {
    return globalThis.localStorage ?? memoryStore();
  } catch {
    return memoryStore(); // reading it throws where site data is blocked
  }
}

/**
 * @param {any} [backing]
 * @param {(key: string) => boolean} [cached] what may go first when storage is full
 */
export function storage(backing = localStore(), cached = () => false) {
  return {
    get(key) {
      try {
        const raw = backing.getItem(key);
        return raw === null ? null : JSON.parse(raw);
      } catch {
        return null;
      }
    },
    set(key, value) {
      if (value === undefined) {
        return this.remove(key);
      }
      let text;
      try {
        text = JSON.stringify(value);
        backing.setItem(key, text);
        return true;
      } catch {
        // full: drop what can be fetched again, and try once more
      }
      try {
        const keys = Array.from({length: backing.length}, (_, i) => backing.key(i));
        keys.filter((k) => cached(k) && k !== key).forEach((k) => backing.removeItem(k));
        backing.setItem(key, text);
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        backing.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}
