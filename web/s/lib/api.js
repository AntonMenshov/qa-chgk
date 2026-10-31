// Calls to the tournament's Apps Script backend. POST with a text/plain body: Apps
// Script web apps don't answer CORS preflights, and text/plain needs none.

export class BackendError extends Error {
  /** `retry`: false when the server says the request itself is wrong (sending it again won't help). */
  constructor(message, retry = true) {
    super(message);
    this.name = 'BackendError';
    this.retry = retry;
  }
}

/**
 * Seen live once: a request Google never answered (a photo upload, over 90 s). Without a
 * limit it would hold a photo slot, or the whole marks queue, until the browser gives up;
 * after the limit it fails and is retried like any failure (marks and photos carry their
 * own IDs, so a retry never counts twice).
 */
export const REQUEST_TIMEOUT_MS = 45000;

/**
 * A refused token, in words for the juror or the projector: the link was most likely
 * replaced (a leaked link, `chgk replace-token`), and the fix is the new QR code.
 */
const REFUSED = {
  'forbidden: jury token required':
    'ключ жюри больше не действует (ссылку заменили): отсканируйте новый QR «Доступ жюри» с листа жюри',
  'forbidden: board token required':
    'ссылка табло больше не действует (её заменили): откройте новую по QR на стр. 2 листа жюри',
};

/** A function (action, payload) => reply for one backend and token (jury or board). */
export function backend(url, token, fetchImpl = (...a) => fetch(...a), timeoutMs = REQUEST_TIMEOUT_MS) {
  return async (action, payload = {}) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let response;
    let data;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: JSON.stringify({...payload, action, token}),
        redirect: 'follow',
        signal: abort.signal,
      });
      data = await response.json(); // within the limit too: a reply can stall halfway
    } catch (err) {
      if (abort.signal.aborted) {
        throw new BackendError(`сервер не ответил за ${Math.round(timeoutMs / 1000)} с`);
      }
      if (err instanceof SyntaxError) {
        throw new BackendError(`сервер ответил не JSON (HTTP ${response.status})`);
      }
      throw new BackendError(`нет связи с сервером (${err && err.message ? err.message : err})`);
    } finally {
      clearTimeout(timer);
    }
    if (!data?.ok) {
      const message = REFUSED[data?.error] || data?.error || `ошибка сервера (HTTP ${response.status})`;
      throw new BackendError(message, data?.retry !== false);
    }
    return data;
  };
}
