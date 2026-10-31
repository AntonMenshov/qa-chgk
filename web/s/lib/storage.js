// JSON values in localStorage. Never throws: private mode or a full disk only loses
// persistence, not the session.

function localStore() {
  try {
    return globalThis.localStorage;
  } catch {
    return null; // reading it throws where site data is blocked
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
      try {
        backing.setItem(key, JSON.stringify(value));
      } catch {
        // ignore
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
