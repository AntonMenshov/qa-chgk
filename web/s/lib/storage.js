// JSON values in localStorage. Never throws: with storage blocked they last until a reload, in
// memory. When it is full, cached copies of tournaments go first, since they can be fetched again;
// set() returns false if the value still can't be saved.

const CACHED = /^chgk\.state\./;

function memoryStore() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: () => null,
    length: 0,
  };
}

function localStore() {
  try {
    return globalThis.localStorage ?? memoryStore();
  } catch {
    return memoryStore(); // reading it throws where site data is blocked
  }
}

export function storage(backing = localStore()) {
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
      const text = JSON.stringify(value);
      try {
        backing.setItem(key, text);
        return true;
      } catch {
        // full: drop what can be fetched again, and try once more
      }
      try {
        const keys = Array.from({length: backing.length}, (_, i) => backing.key(i));
        keys.filter((k) => CACHED.test(k) && k !== key).forEach((k) => backing.removeItem(k));
        backing.setItem(key, text);
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        backing.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}
