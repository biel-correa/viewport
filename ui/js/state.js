/**
 * Central application state and localStorage persistence.
 */

export const STORAGE_KEY = 'viewport_user_saved_pcs';
export const LEGACY_STORAGE_KEY = 'myrdp_user_saved_pcs';
export const DOCK_EVENT_KEY = 'viewport_dock_event';

export function loadSavedMachines() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        if (!localStorage.getItem(STORAGE_KEY)) {
          localStorage.setItem(STORAGE_KEY, raw);
        }
        return parsed;
      }
    }
  } catch (_) {}
  return [];
}

export function persistSavedMachines(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (_) {}
}

export function createAppState() {
  return {
    streamPort: 0,
    activeTabId: 'tab-dashboard',
    detachedWindowMode: false,
    standaloneDetachedSessionId: null,
    canvasInputCaptured: false,
    activeStream: null,
    editingMachineId: null,
    tabs: [
      {
        id: 'tab-dashboard',
        type: 'dashboard',
        title: 'Dashboard',
        status: 'idle'
      }
    ],
    savedMachines: loadSavedMachines()
  };
}
