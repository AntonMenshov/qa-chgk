// Calls to the tournament's Apps Script backend. POST with a text/plain body: Apps
// Script web apps don't answer CORS preflights, and text/plain needs none.

export class BackendError extends Error {}

/** A function (action, payload) => reply for one backend and jury token. */
export function backend(url, token, fetchImpl = (...a) => fetch(...a)) {
  return async (action, payload = {}) => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, token, ...payload }),
        redirect: "follow",
      });
    } catch (err) {
      throw new BackendError(`нет связи с сервером (${err && err.message ? err.message : err})`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new BackendError(`сервер ответил не JSON (HTTP ${response.status})`);
    }
    if (!data.ok) throw new BackendError(data.error || `ошибка сервера (HTTP ${response.status})`);
    return data;
  };
}
