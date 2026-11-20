/**
 * ViewPort — Remote Desktop Client Entrypoint (ES Modules)
 */

import { isTauri, invoke, initTauriBodyClass } from './js/tauri.js';
import { createAppState } from './js/state.js';
import { getDomRefs } from './js/dom.js';
import { createKeymapController } from './js/keymap.js';
import { createConnectionFormController } from './js/form.js';
import { createSavedMachinesController } from './js/saved-machines.js';
import { createSessionController } from './js/sessions.js';
import { initSoftwareUpdater } from './js/updater.js';

document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }

  initTauriBodyClass();

  const state = createAppState();
  const dom = getDomRefs();

  if (isTauri) {
    try {
      state.streamPort = (await invoke('get_stream_port')) || 0;
    } catch (e) {
      console.warn('Could not get stream port:', e);
    }
  }

  const keymap = createKeymapController(dom);

  let savedMachinesCtrl = null;
  let formCtrl = null;
  let sessionCtrl = null;

  sessionCtrl = createSessionController({
    state,
    dom,
    onEditFromError: (targetTab) => {
      const savedMachine =
        (targetTab.savedMachineId &&
          state.savedMachines.find((m) => m.id === targetTab.savedMachineId)) ||
        state.savedMachines.find(
          (m) =>
            m.ip === targetTab.host &&
            Number(m.port || 3389) === Number(targetTab.port || 3389) &&
            m.user === targetTab.user
        );

      if (savedMachine) {
        formCtrl.populateFormFromMachine(savedMachine);
        formCtrl.setEditingMachine(savedMachine.id);
      } else if (targetTab.host) {
        formCtrl.populateFormFromSessionTab(targetTab);
      }
    }
  });

  formCtrl = createConnectionFormController({
    state,
    dom,
    keymap,
    onSavedMachinesChange: () => savedMachinesCtrl?.renderSavedMachines(),
    onConnect: (options) => sessionCtrl.spawnSession(options)
  });

  savedMachinesCtrl = createSavedMachinesController({
    state,
    dom,
    onEditMachine: (machine, { focusField } = {}) => {
      formCtrl.populateFormFromMachine(machine);
      formCtrl.setEditingMachine(machine.id);
      if (focusField === 'password') {
        dom.customPassInput.focus();
      } else {
        dom.pcFriendlyInput.focus();
      }
    },
    onDeleteEditingMachine: () => formCtrl.clearEditMode(),
    onLaunchMachine: (options) => sessionCtrl.spawnSession(options)
  });

  const params = new URLSearchParams(window.location.search);
  const detachedParam = params.get('detached');

  if (detachedParam) {
    state.standaloneDetachedSessionId = Number(detachedParam);
    state.detachedWindowMode = true;

    let detachedKeyMap = null;
    try {
      const rawKm = params.get('keyMap');
      if (rawKm) detachedKeyMap = JSON.parse(rawKm);
    } catch (_) {}

    const detachedTab = {
      id: params.get('tabId') || `tab-detached-${detachedParam}`,
      backendSessionId: Number(detachedParam),
      type: 'session',
      title: params.get('title') || `Session #${detachedParam}`,
      host: params.get('host') || '',
      port: Number(params.get('port')) || 3389,
      user: params.get('user') || '',
      resolution: params.get('resolution') || '1920x1080',
      scale: params.get('scale') || '1x FHD',
      keyMap: detachedKeyMap,
      status: 'connected',
      isDetached: false,
      fps: 60
    };

    state.tabs = [detachedTab];
    dom.appWindow.classList.add('detached-mode');
    dom.mainChrome.classList.add('hidden');
    dom.detachedChrome.classList.remove('hidden');
    if (dom.detachedSessionLabel) dom.detachedSessionLabel.textContent = detachedTab.title;

    sessionCtrl.activateTab(detachedTab.id);
  } else {
    sessionCtrl.startSessionStatusPolling();
    sessionCtrl.renderTabs();
    savedMachinesCtrl.renderSavedMachines();
    sessionCtrl.activateTab('tab-dashboard');
    initSoftwareUpdater();
  }
});
