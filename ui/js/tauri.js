/**
 * Tauri 2 IPC & Event Bridge (safe no-op fallback in plain browser preview).
 */

function resolveTauriInvoke() {
  return (
    (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) ||
    (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
    null
  );
}

const tauriInvoke = resolveTauriInvoke();

export const isTauri = typeof tauriInvoke === 'function';

export function initTauriBodyClass() {
  if (isTauri) {
    document.body.classList.add('is-tauri');
  }
}

export function invoke(cmd, args = {}) {
  if (isTauri) {
    return tauriInvoke(cmd, args);
  }
  return Promise.reject(new Error('Tauri runtime not available'));
}

export function listenTauriEvent(eventName, handler) {
  if (window.__TAURI__?.event?.listen) {
    return window.__TAURI__.event.listen(eventName, handler);
  }
  return Promise.resolve(() => {});
}
