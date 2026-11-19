/**
 * ViewPort — macOS Remote Desktop Client (Tauri 2 + IronRDP Rust Core)
 */

import { RdpCanvasStream } from './js/canvas.js';
import { ALL_KEY_CODES, DEFAULT_KEY_MAP } from './js/scancodes.js';

document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }

  const tauriInvoke =
    (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) ||
    (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  const isTauri = typeof tauriInvoke === 'function';
  if (isTauri) {
    document.body.classList.add('is-tauri');
  }

  const invoke = (cmd, args = {}) => {
    if (isTauri) {
      return tauriInvoke(cmd, args);
    }
    return Promise.reject(new Error('Tauri runtime not available'));
  };

  /* ==========================================================================
     1. Application State & User Saved PCs Persistence
     ========================================================================== */
  const STORAGE_KEY = 'viewport_user_saved_pcs';
  const LEGACY_STORAGE_KEY = 'myrdp_user_saved_pcs';

  function loadSavedMachines() {
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

  function persistSavedMachines(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  const state = {
    streamPort: 0,
    activeTabId: 'tab-dashboard',
    detachedWindowMode: false,
    standaloneDetachedSessionId: null,
    canvasInputCaptured: false,
    activeStream: null,
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

  if (isTauri) {
    try {
      state.streamPort = (await invoke('get_stream_port')) || 0;
    } catch (e) {
      console.warn('Could not get stream port:', e);
    }
  }

  /* ==========================================================================
     2. DOM Element References
     ========================================================================== */
  const appWindow = document.getElementById('app');
  const mainChrome = document.getElementById('main-chrome');
  const detachedChrome = document.getElementById('detached-chrome');
  const tabStrip = document.getElementById('tab-strip');
  const telemetryBadge = document.getElementById('telemetry-badge');
  const telemetryRes = document.getElementById('telemetry-res');
  const telemetryFps = document.getElementById('telemetry-fps');
  const telemetryPing = document.getElementById('telemetry-ping');
  const detachedTelemetryLabel = document.getElementById('detached-telemetry-label');

  const dashboardView = document.getElementById('dashboard-view');
  const sessionView = document.getElementById('session-view');
  const savedGrid = document.getElementById('saved-grid');
  const savedCount = document.getElementById('saved-count');
  const searchInput = document.getElementById('search-hosts');

  // Form Elements
  const addPcForm = document.getElementById('add-pc-form');
  const pcNameInput = document.getElementById('pc-name');
  const customUserInput = document.getElementById('custom-user');
  const customPassInput = document.getElementById('custom-pass');
  const pcFriendlyInput = document.getElementById('pc-friendly');
  const pcGroupSelect = document.getElementById('pc-group');
  const pcGatewaySelect = document.getElementById('pc-gateway');
  const chkBypassGw = document.getElementById('chk-bypass-gw');
  const lblBypassGw = document.getElementById('lbl-bypass-gw');
  const chkNla = document.getElementById('chk-nla');
  const chkReconnect = document.getElementById('chk-reconnect');
  const chkSwapMouse = document.getElementById('chk-swap-mouse');
  const chkDynamicRes = document.getElementById('chk-dynamic-res');
  const chkRetina = document.getElementById('chk-retina');
  const chkMic = document.getElementById('chk-mic');
  const chkCamera = document.getElementById('chk-camera');
  const chkClipboard = document.getElementById('chk-clipboard');
  const pcAudioOut = document.getElementById('pc-audio-out');
  const pcResolutionSelect = document.getElementById('pc-resolution');
  const pcColorDepthSelect = document.getElementById('pc-color-depth');
  const pcMacInput = document.getElementById('pc-mac');
  const pcWolBroadcastInput = document.getElementById('pc-wol-broadcast');
  const chkWolConnect = document.getElementById('chk-wol-connect');
  const btnDetectMac = document.getElementById('btn-detect-mac');
  const formCardTitle = document.getElementById('form-card-title');
  const btnSaveOnly = document.getElementById('btn-save-only');
  const btnResetForm = document.getElementById('btn-reset-form');
  const workspaceEl = document.querySelector('.workspace');

  const btnToggleAdvanced = document.getElementById('btn-toggle-advanced');
  const advancedContainer = document.getElementById('advanced-container');
  const segmentedTabs = document.querySelectorAll('.seg-tab');
  const tabPanes = {
    general: document.getElementById('tab-pane-general'),
    display: document.getElementById('tab-pane-display'),
    devices: document.getElementById('tab-pane-devices'),
    keyboard: document.getElementById('tab-pane-keyboard'),
    folders: document.getElementById('tab-pane-folders')
  };

  const keyMapMetaSelect = document.getElementById('key-map-meta');
  const keyMapAltSelect = document.getElementById('key-map-alt');
  const keyMapCtrlSelect = document.getElementById('key-map-ctrl');
  const keyMapCapsSelect = document.getElementById('key-map-caps');
  const customKeymapList = document.getElementById('custom-keymap-list');

  const rdpCanvas = document.getElementById('rdp-canvas');
  const tabContextMenu = document.getElementById('tab-context-menu');
  const ctxTabTitle = document.getElementById('ctx-tab-title');
  const ctxTabQuality = document.getElementById('ctx-tab-quality');

  const connectingOverlay = document.getElementById('connecting-overlay');
  const connectingSubtext = document.getElementById('connecting-subtext');
  const errorModal = document.getElementById('error-modal');
  const errorDescription = document.getElementById('error-description');
  const errorHostLabel = document.getElementById('error-host-label');
  const errorReconnectLabel = document.getElementById('error-reconnect-label');

  let draggedTabId = null;
  let contextMenuTabId = null;
  let editingMachineId = null;

  function closeTabContextMenu() {
    contextMenuTabId = null;
    if (tabContextMenu) tabContextMenu.classList.add('hidden');
  }

  function openTabContextMenu(tab, clientX, clientY) {
    if (!tabContextMenu) return;
    contextMenuTabId = tab.id;
    if (ctxTabTitle) ctxTabTitle.textContent = tab.title;
    if (ctxTabQuality) {
      ctxTabQuality.textContent = `${(tab.resolution || '1920x1080').replace('x', '×')} • ${tab.scale || '1x FHD'}`;
    }

    tabContextMenu.classList.remove('hidden');
    const rect = tabContextMenu.getBoundingClientRect();
    const x = Math.min(clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(clientY, window.innerHeight - rect.height - 8);
    tabContextMenu.style.left = `${Math.max(8, x)}px`;
    tabContextMenu.style.top = `${Math.max(8, y)}px`;
  }

  /* ==========================================================================
     3. Form Interactions (Progressive Disclosure & Tabs)
     ========================================================================== */
  btnToggleAdvanced.addEventListener('click', () => {
    const isExpanded = btnToggleAdvanced.getAttribute('aria-expanded') === 'true';
    btnToggleAdvanced.setAttribute('aria-expanded', String(!isExpanded));
    advancedContainer.classList.toggle('hidden', isExpanded);
  });

  segmentedTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      segmentedTabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      Object.entries(tabPanes).forEach(([key, pane]) => {
        pane.classList.toggle('hidden', key !== targetTab);
      });
    });
  });

  pcGatewaySelect.addEventListener('change', () => {
    const hasGateway = pcGatewaySelect.value !== 'none';
    chkBypassGw.disabled = !hasGateway;
    lblBypassGw.classList.toggle('disabled', !hasGateway);
  });

  chkRetina.addEventListener('change', () => {
    rdpCanvas.classList.toggle('pixelated', chkRetina.checked);
  });

  if (chkDynamicRes) {
    chkDynamicRes.addEventListener('change', () => {
      if (state.activeStream) {
        state.activeStream.dynamicResize = chkDynamicRes.checked;
        if (chkDynamicRes.checked) {
          state.activeStream.checkViewportResize();
        }
      }
    });
  }

  function parseHostAndPort(rawHost) {
    const trimmed = rawHost.trim();
    if (trimmed.includes(':')) {
      const lastColon = trimmed.lastIndexOf(':');
      const h = trimmed.slice(0, lastColon).trim();
      const p = Number(trimmed.slice(lastColon + 1).trim());
      return { host: h, port: p > 0 && p <= 65535 ? p : 3389 };
    }
    return { host: trimmed, port: 3389 };
  }

  function getFreeWorkspaceResolution() {
    const rawW = (workspaceEl && workspaceEl.clientWidth > 200)
      ? workspaceEl.clientWidth
      : window.innerWidth;
    const rawH = (workspaceEl && workspaceEl.clientHeight > 200)
      ? workspaceEl.clientHeight
      : (window.innerHeight - 46);
    return RdpCanvasStream.normalizeResolution(rawW, rawH);
  }

  function parseResolution(resStr) {
    if (!resStr || resStr === 'fit') {
      return getFreeWorkspaceResolution();
    }
    const [w, h] = resStr.split('x').map(Number);
    if (!w || !h) {
      return getFreeWorkspaceResolution();
    }
    return RdpCanvasStream.normalizeResolution(w, h);
  }

  function resolveCredentials() {
    const rawUser = customUserInput.value.trim();
    const password = customPassInput.value;
    let domain = null;
    let username = rawUser;

    if (rawUser.includes('\\')) {
      const parts = rawUser.split('\\');
      domain = parts[0] || null;
      username = parts.slice(1).join('\\') || '';
    }

    return { username, password, domain };
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function addCustomKeyRuleRow(fromCode = 'CapsLock', toCode = 'ControlLeft') {
    if (!customKeymapList) return;
    const row = document.createElement('div');
    row.className = 'keymap-rule-row';

    const fromOptions = ALL_KEY_CODES.map(
      (c) => `<option value="${c}" ${c === fromCode ? 'selected' : ''}>${c}</option>`
    ).join('');
    const toOptions = ['None', ...ALL_KEY_CODES].map(
      (c) => `<option value="${c}" ${c === toCode ? 'selected' : ''}>${c === 'None' ? 'Disabled' : c}</option>`
    ).join('');

    row.innerHTML = `
      <div class="mac-select-wrapper">
        <select class="mac-select keymap-from">${fromOptions}</select>
        <span class="select-chevrons">⌄</span>
      </div>
      <span class="keymap-rule-arrow">→</span>
      <div class="mac-select-wrapper">
        <select class="mac-select keymap-to">${toOptions}</select>
        <span class="select-chevrons">⌄</span>
      </div>
      <button type="button" class="tab-act-btn close" title="Remove rule">✕</button>
    `;

    row.querySelector('.close').addEventListener('click', () => row.remove());
    customKeymapList.appendChild(row);
  }

  function readKeyMapFromForm() {
    const custom = [];
    if (customKeymapList) {
      customKeymapList.querySelectorAll('.keymap-rule-row').forEach((row) => {
        const from = row.querySelector('.keymap-from')?.value;
        const to = row.querySelector('.keymap-to')?.value;
        if (from && to) custom.push({ from, to });
      });
    }
    return {
      meta: keyMapMetaSelect ? keyMapMetaSelect.value : DEFAULT_KEY_MAP.meta,
      alt: keyMapAltSelect ? keyMapAltSelect.value : DEFAULT_KEY_MAP.alt,
      ctrl: keyMapCtrlSelect ? keyMapCtrlSelect.value : DEFAULT_KEY_MAP.ctrl,
      caps: keyMapCapsSelect ? keyMapCapsSelect.value : DEFAULT_KEY_MAP.caps,
      custom
    };
  }

  function applyKeyMapToForm(keyMap) {
    const km = { ...DEFAULT_KEY_MAP, ...(keyMap || {}) };
    if (keyMapMetaSelect) keyMapMetaSelect.value = km.meta || DEFAULT_KEY_MAP.meta;
    if (keyMapAltSelect) keyMapAltSelect.value = km.alt || DEFAULT_KEY_MAP.alt;
    if (keyMapCtrlSelect) keyMapCtrlSelect.value = km.ctrl || DEFAULT_KEY_MAP.ctrl;
    if (keyMapCapsSelect) keyMapCapsSelect.value = km.caps || DEFAULT_KEY_MAP.caps;
    if (customKeymapList) {
      customKeymapList.innerHTML = '';
      if (Array.isArray(km.custom)) {
        km.custom.forEach((rule) => {
          if (rule?.from && rule?.to) addCustomKeyRuleRow(rule.from, rule.to);
        });
      }
    }
  }

  const btnKeymapMacWin = document.getElementById('btn-keymap-mac-win');
  if (btnKeymapMacWin) {
    btnKeymapMacWin.addEventListener('click', () => {
      applyKeyMapToForm({
        meta: 'Control',
        alt: 'Alt',
        ctrl: 'Meta',
        caps: keyMapCapsSelect ? keyMapCapsSelect.value : DEFAULT_KEY_MAP.caps,
        custom: readKeyMapFromForm().custom
      });
    });
  }

  const btnKeymapReset = document.getElementById('btn-keymap-reset');
  if (btnKeymapReset) {
    btnKeymapReset.addEventListener('click', () => applyKeyMapToForm(DEFAULT_KEY_MAP));
  }

  const btnAddKeyrule = document.getElementById('btn-add-keyrule');
  if (btnAddKeyrule) {
    btnAddKeyrule.addEventListener('click', () => addCustomKeyRuleRow());
  }

  if (btnDetectMac) {
    btnDetectMac.addEventListener('click', async () => {
      const { host } = parseHostAndPort(pcNameInput.value);
      if (!host) {
        pcNameInput.focus();
        return;
      }
      if (!isTauri) return;
      const origText = btnDetectMac.textContent;
      btnDetectMac.textContent = '...';
      btnDetectMac.disabled = true;
      const hadMac = Boolean(pcMacInput.value.trim());
      try {
        // Trigger a brief TCP probe first so macOS refreshes its ARP entry if the host is online on LAN
        await invoke('probe_tcp_port', { host, port: 3389 }).catch(() => false);
        const mac = await invoke('detect_mac_address', { host });
        if (mac) {
          pcMacInput.value = mac;
          if (!hadMac && chkWolConnect) {
            chkWolConnect.checked = true;
          }
          btnDetectMac.textContent = 'Found';
        } else {
          btnDetectMac.textContent = 'Not in ARP';
        }
      } catch (_) {
        btnDetectMac.textContent = 'Error';
      } finally {
        setTimeout(() => {
          btnDetectMac.textContent = origText;
          btnDetectMac.disabled = false;
        }, 1400);
      }
    });
  }

  function buildSavedMachineEntry(existingMachine = null) {
    const { host, port } = parseHostAndPort(pcNameInput.value);
    const { username, password, domain } = resolveCredentials();
    const nickname = pcFriendlyInput.value.trim();
    const group = pcGroupSelect.value;
    const resolution = pcResolutionSelect.value;
    const enableNla = chkNla ? chkNla.checked : true;
    const enableMic = chkMic ? chkMic.checked : true;
    const enableCamera = chkCamera ? chkCamera.checked : true;
    const enableClipboard = chkClipboard ? chkClipboard.checked : true;
    const audioOut = pcAudioOut ? pcAudioOut.value : 'local';

    return {
      id: existingMachine ? existingMachine.id : `srv-${Date.now()}`,
      nickname,
      name: nickname || host,
      ip: host,
      port,
      user: username,
      domain,
      password,
      enableNla,
      enableMic,
      enableCamera,
      enableClipboard,
      audioOut,
      swapMouse: chkSwapMouse ? chkSwapMouse.checked : false,
      dynamicRes: chkDynamicRes ? chkDynamicRes.checked : true,
      retina: chkRetina ? chkRetina.checked : true,
      reconnect: chkReconnect ? chkReconnect.checked : true,
      colorDepth: pcColorDepthSelect ? pcColorDepthSelect.value : '32',
      keyMap: readKeyMapFromForm(),
      macAddress: pcMacInput ? pcMacInput.value.trim() : '',
      wolBroadcast: pcWolBroadcastInput ? pcWolBroadcastInput.value.trim() : '',
      wakeOnConnect: chkWolConnect ? chkWolConnect.checked : false,
      group,
      isServer: group.includes('Server'),
      lastConnected: existingMachine ? existingMachine.lastConnected : 'Saved',
      resolution
    };
  }

  function setEditingMachine(machineId) {
    editingMachineId = machineId;
    const isEditing = Boolean(machineId);
    if (formCardTitle) formCardTitle.textContent = isEditing ? 'Edit Saved PC' : 'Connect to PC';
    if (btnSaveOnly) btnSaveOnly.textContent = isEditing ? 'Update PC' : 'Save to PCs';
    if (btnResetForm) btnResetForm.textContent = isEditing ? 'Cancel' : 'Reset';
    renderSavedMachines(searchInput.value);
  }

  function populateFormFromMachine(machine) {
    pcFriendlyInput.value = machine.nickname || (machine.name !== machine.ip ? machine.name : '');
    pcNameInput.value = machine.port && machine.port !== 3389 ? `${machine.ip}:${machine.port}` : machine.ip;
    customUserInput.value = machine.domain ? `${machine.domain}\\${machine.user}` : machine.user;
    customPassInput.value = machine.password || '';
    if (machine.group) pcGroupSelect.value = machine.group;
    if (machine.resolution) pcResolutionSelect.value = machine.resolution;
    if (pcColorDepthSelect && machine.colorDepth) pcColorDepthSelect.value = String(machine.colorDepth);
    if (chkNla) chkNla.checked = machine.enableNla !== false;
    if (chkReconnect) chkReconnect.checked = machine.reconnect !== false;
    if (chkSwapMouse) chkSwapMouse.checked = Boolean(machine.swapMouse);
    if (chkDynamicRes) chkDynamicRes.checked = machine.dynamicRes !== false;
    if (chkRetina) chkRetina.checked = machine.retina !== false;
    if (pcAudioOut && machine.audioOut) pcAudioOut.value = machine.audioOut;
    if (chkClipboard) chkClipboard.checked = machine.enableClipboard !== false;
    if (chkMic) chkMic.checked = machine.enableMic !== false;
    if (chkCamera) chkCamera.checked = machine.enableCamera !== false;
    if (pcMacInput) pcMacInput.value = machine.macAddress || '';
    if (pcWolBroadcastInput) pcWolBroadcastInput.value = machine.wolBroadcast || '';
    if (chkWolConnect) chkWolConnect.checked = Boolean(machine.wakeOnConnect);
    applyKeyMapToForm(machine.keyMap);
  }

  function clearEditMode() {
    addPcForm.reset();
    applyKeyMapToForm(DEFAULT_KEY_MAP);
    chkBypassGw.disabled = true;
    lblBypassGw.classList.add('disabled');
    setEditingMachine(null);
  }

  // "Save to PCs" / "Update PC" button
  btnSaveOnly.addEventListener('click', () => {
    const { host } = parseHostAndPort(pcNameInput.value);
    const { username } = resolveCredentials();
    if (!host || !username) {
      if (!host) pcNameInput.focus();
      else customUserInput.focus();
      return;
    }

    const { port } = parseHostAndPort(pcNameInput.value);
    const existingIdx = editingMachineId
      ? state.savedMachines.findIndex((m) => m.id === editingMachineId)
      : state.savedMachines.findIndex(
          (m) => m.ip === host && m.port === port && m.user === username
        );

    const existing = existingIdx !== -1 ? state.savedMachines[existingIdx] : null;
    const entry = buildSavedMachineEntry(existing);

    if (existingIdx !== -1) {
      state.savedMachines[existingIdx] = entry;
    } else {
      state.savedMachines.unshift(entry);
    }

    persistSavedMachines(state.savedMachines);
    if (editingMachineId) {
      clearEditMode();
    } else {
      renderSavedMachines(searchInput.value);
    }
  });

  // Reset / Cancel button
  btnResetForm.addEventListener('click', clearEditMode);

  // Primary "Connect" submit
  addPcForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { host, port } = parseHostAndPort(pcNameInput.value);
    const { username, password, domain } = resolveCredentials();
    if (!host || !username) return;

    const nickname = pcFriendlyInput.value.trim();
    const selectedOpt = pcResolutionSelect.options[pcResolutionSelect.selectedIndex];
    const enableNla = chkNla ? chkNla.checked : true;
    const enableMic = chkMic ? chkMic.checked : true;
    const enableCamera = chkCamera ? chkCamera.checked : true;
    const enableClipboard = chkClipboard ? chkClipboard.checked : true;
    const enableAudio = pcAudioOut ? pcAudioOut.value !== 'mute' : true;

    const keyMap = readKeyMapFromForm();
    const resolution = pcResolutionSelect.value;
    const macAddress = pcMacInput ? pcMacInput.value.trim() : '';
    const wolBroadcast = pcWolBroadcastInput ? pcWolBroadcastInput.value.trim() : '';
    const wakeOnConnect = chkWolConnect ? chkWolConnect.checked : false;
    let activeSavedId = editingMachineId;

    if (editingMachineId) {
      const idx = state.savedMachines.findIndex((m) => m.id === editingMachineId);
      if (idx !== -1) {
        state.savedMachines[idx] = buildSavedMachineEntry(state.savedMachines[idx]);
        persistSavedMachines(state.savedMachines);
      }
      clearEditMode();
    }

    spawnSession({
      savedMachineId: activeSavedId,
      host,
      port,
      user: username,
      password,
      domain,
      enableNla,
      enableMic,
      enableAudio,
      enableCamera,
      enableClipboard,
      keyMap,
      macAddress,
      wolBroadcast,
      wakeOnConnect,
      nickname,
      resolution,
      scale: selectedOpt?.dataset.scale || '1x FHD'
    });
  });

  /* ==========================================================================
     4. Tab Strip Rendering & Drag-and-Drop Reordering
     ========================================================================== */
  function renderTabs() {
    tabStrip.innerHTML = '';

    const visibleTabs = state.tabs.filter((t) => !t.isDetached);

    visibleTabs.forEach((tab) => {
      const tabEl = document.createElement('div');
      tabEl.className = `session-tab ${tab.id === state.activeTabId ? 'active' : ''}`;
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('data-tauri-drag-region', 'false');
      tabEl.setAttribute('draggable', 'true');
      tabEl.dataset.id = tab.id;
      if (tab.tooltip) {
        tabEl.title = tab.tooltip;
      }

      const dotClass = tab.type === 'dashboard' ? 'idle' : tab.status;
      const actionsHtml = tab.type === 'session'
        ? `
          <div class="tab-actions">
            <button class="tab-act-btn detach" data-action="detach" title="Detach session into standalone macOS window">⧉</button>
            <button class="tab-act-btn close" data-action="close" title="Disconnect & Close Tab">✕</button>
          </div>
        `
        : '';

      tabEl.innerHTML = `
        <span class="status-dot ${dotClass}"></span>
        <span class="tab-title ${tab.type === 'session' ? 'mono' : ''}">${escapeHtml(tab.title)}</span>
        ${actionsHtml}
      `;

      tabEl.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('.tab-act-btn');
        if (actionBtn) {
          e.stopPropagation();
          const action = actionBtn.dataset.action;
          if (action === 'close') closeTab(tab.id);
          if (action === 'detach') enterDetachedMode(tab.id);
          return;
        }
        activateTab(tab.id);
      });

      if (tab.type === 'session') {
        tabEl.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openTabContextMenu(tab, e.clientX, e.clientY);
        });
      }

      tabEl.addEventListener('dragstart', () => {
        draggedTabId = tab.id;
        tabEl.classList.add('dragging');
      });

      tabEl.addEventListener('dragend', () => {
        tabEl.classList.remove('dragging');
        draggedTabId = null;
      });

      tabEl.addEventListener('dragover', (e) => e.preventDefault());

      tabEl.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!draggedTabId || draggedTabId === tab.id) return;
        const fromIdx = state.tabs.findIndex((t) => t.id === draggedTabId);
        const toIdx = state.tabs.findIndex((t) => t.id === tab.id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [moved] = state.tabs.splice(fromIdx, 1);
          state.tabs.splice(toIdx, 0, moved);
          renderTabs();
        }
      });

      tabStrip.appendChild(tabEl);
    });
  }

  function formatPing(pingMs) {
    if (pingMs === null || pingMs === undefined || pingMs < 0) return '-- ms';
    return pingMs === 0 ? '<1 ms' : `${pingMs} ms`;
  }

  function updateTelemetryDisplay(tab) {
    const resText = (tab.resolution || '1920x1080').replace('x', '×');
    const fpsText = `${tab.fps ?? 60} FPS`;
    const pingText = formatPing(tab.pingMs);
    if (telemetryRes) telemetryRes.textContent = resText;
    if (telemetryFps) telemetryFps.textContent = fpsText;
    if (telemetryPing) telemetryPing.textContent = pingText;
    if (detachedTelemetryLabel) {
      detachedTelemetryLabel.textContent = `${resText} • ${fpsText} • ${pingText}`;
    }
  }

  function ensureStreamForTab(tab) {
    if (!tab || tab.type !== 'session' || !tab.backendSessionId) {
      if (state.activeStream) {
        state.activeStream.destroy();
        state.activeStream = null;
      }
      return;
    }

    // Keep existing stream if already subscribed to this backend session ID
    if (state.activeStream && Number(state.activeStream.sessionId) === Number(tab.backendSessionId)) {
      return;
    }

    if (state.activeStream) {
      state.activeStream.destroy();
      state.activeStream = null;
    }

    const { width, height } = parseResolution(tab.resolution);
    const ctx = rdpCanvas.getContext('2d', { alpha: false });
    rdpCanvas.width = width;
    rdpCanvas.height = height;
    ctx.fillStyle = '#040507';
    ctx.fillRect(0, 0, width, height);

    state.activeStream = new RdpCanvasStream(
      rdpCanvas,
      tab.backendSessionId,
      state.streamPort,
      {
        width,
        height,
        swapMouse: chkSwapMouse && chkSwapMouse.checked,
        dynamicResize: chkDynamicRes ? chkDynamicRes.checked : true,
        keyMap: tab.keyMap || null,
        onResolutionChange: (newW, newH) => {
          tab.resolution = `${newW}x${newH}`;
          updateTelemetryDisplay(tab);
        },
        onFpsUpdate: (fps) => {
          tab.fps = fps;
          updateTelemetryDisplay(tab);
        },
        onPingUpdate: (pingMs) => {
          tab.pingMs = pingMs;
          updateTelemetryDisplay(tab);
        }
      }
    );
  }

  function syncActiveTabView(activeTab) {
    if (!activeTab) return;

    if (activeTab.type === 'dashboard') {
      dashboardView.classList.remove('hidden');
      sessionView.classList.add('hidden');
      telemetryBadge.classList.add('hidden');
      releaseCanvasInput();
      if (state.activeStream) {
        state.activeStream.destroy();
        state.activeStream = null;
      }
    } else {
      dashboardView.classList.add('hidden');
      sessionView.classList.remove('hidden');
      telemetryBadge.classList.remove('hidden');

      updateTelemetryDisplay(activeTab);
      errorHostLabel.textContent = `${activeTab.host}:${activeTab.port || 3389}`;
      if (errorReconnectLabel) {
        errorReconnectLabel.textContent = chkReconnect && chkReconnect.checked ? 'Enabled' : 'Disabled';
      }

      if (activeTab.errorMessage && errorDescription) {
        errorDescription.textContent = activeTab.errorMessage;
      }

      if (activeTab.status === 'connecting') {
        connectingOverlay.classList.remove('hidden');
        errorModal.classList.add('hidden');
      } else if (activeTab.status === 'error') {
        connectingOverlay.classList.add('hidden');
        errorModal.classList.remove('hidden');
        const btnErrorWake = document.getElementById('btn-error-wake');
        if (btnErrorWake) {
          btnErrorWake.classList.toggle('hidden', !activeTab.macAddress);
        }
      } else {
        connectingOverlay.classList.add('hidden');
        errorModal.classList.add('hidden');
      }

      ensureStreamForTab(activeTab);
    }
  }

  function activateTab(tabId) {
    state.activeTabId = tabId;
    const activeTab = state.tabs.find((t) => t.id === tabId);
    if (!activeTab) return;

    renderTabs();
    syncActiveTabView(activeTab);
  }

  async function closeTab(tabId) {
    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const tab = state.tabs[idx];

    if (state.activeTabId === tabId && state.activeStream) {
      state.activeStream.destroy();
      state.activeStream = null;
    }

    if (tab.backendSessionId && isTauri) {
      try {
        await invoke('disconnect_session', { sessionId: Number(tab.backendSessionId) });
      } catch (_) {}
    }

    if (state.standaloneDetachedSessionId) {
      window.close();
      return;
    }

    state.tabs.splice(idx, 1);

    if (state.detachedWindowMode) exitDetachedMode();

    if (state.activeTabId === tabId) {
      const visible = state.tabs.filter((t) => !t.isDetached);
      const fallback = visible[visible.length - 1] || state.tabs[0];
      activateTab(fallback ? fallback.id : 'tab-dashboard');
    } else {
      renderTabs();
    }
  }

  /* ==========================================================================
     5. Saved PCs Grid & Search Filter
     ========================================================================== */
  function renderSavedMachines(filterText = '') {
    const query = filterText.trim().toLowerCase();
    const filtered = state.savedMachines.filter(
      (m) =>
        (m.nickname || '').toLowerCase().includes(query) ||
        (m.name || '').toLowerCase().includes(query) ||
        (m.ip || '').toLowerCase().includes(query) ||
        (m.user || '').toLowerCase().includes(query) ||
        (m.group || '').toLowerCase().includes(query)
    );

    savedCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'machine' : 'machines'}`;
    savedGrid.innerHTML = '';

    if (filtered.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'host-card';
      emptyEl.style.textAlign = 'center';
      emptyEl.style.padding = '28px 18px';
      emptyEl.style.color = 'var(--text-muted)';
      emptyEl.innerHTML = `
        <p style="font-size: 13px;">No saved PCs yet. Enter a host & username on the left and click <strong>Save to PCs</strong> or <strong>Connect</strong>.</p>
      `;
      savedGrid.appendChild(emptyEl);
      return;
    }

    filtered.forEach((machine) => {
      const cardTitle = machine.nickname || machine.name || machine.ip;
      const card = document.createElement('article');
      card.className = `host-card ${machine.id === editingMachineId ? 'editing' : ''}`;
      card.innerHTML = `
        <div class="host-card-top">
          <div class="os-badge ${machine.isServer ? 'server' : ''}">
            <i data-lucide="${machine.isServer ? 'database' : 'monitor'}"></i>
          </div>
          <div class="host-meta">
            <h3>${escapeHtml(cardTitle)}</h3>
            <div class="host-ip mono">${escapeHtml(machine.user)}@${escapeHtml(machine.ip)}:${escapeHtml(machine.port)}</div>
          </div>
          <span class="host-group-tag">${escapeHtml(machine.group || 'Saved PCs')}</span>
          <div class="host-card-actions">
            <button class="tab-act-btn edit btn-edit-saved" title="Edit Saved PC">
              <i data-lucide="pencil"></i>
            </button>
            <button class="tab-act-btn close btn-delete-saved" title="Remove Saved PC">✕</button>
          </div>
        </div>
        <div class="host-card-footer">
          <span class="last-seen">
            <i data-lucide="clock" class="icon-xs"></i>
            ${escapeHtml(machine.lastConnected || 'Saved')}
          </span>
          <div class="host-card-footer-btns">
            ${
              machine.macAddress
                ? `<button class="btn-wake-card" data-id="${escapeHtml(machine.id)}" title="Send Wake-on-LAN packet to ${escapeHtml(machine.macAddress)}">
                    <i data-lucide="power" class="icon-xs"></i>
                    <span>Wake</span>
                  </button>`
                : ''
            }
            <button class="btn-launch-card" data-id="${escapeHtml(machine.id)}">
              <span>Connect</span>
              <i data-lucide="arrow-up-right" class="icon-xs"></i>
            </button>
          </div>
        </div>
      `;

      const wakeBtn = card.querySelector('.btn-wake-card');
      if (wakeBtn) {
        wakeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!isTauri) return;
          const labelSpan = wakeBtn.querySelector('span');
          const origLabel = labelSpan ? labelSpan.textContent : 'Wake';
          if (labelSpan) labelSpan.textContent = 'Waking...';
          wakeBtn.disabled = true;
          try {
            const targets = await invoke('wake_on_lan', {
              mac: machine.macAddress,
              broadcastIp: machine.wolBroadcast || null,
              port: 9
            });
            if (labelSpan) labelSpan.textContent = 'Sent!';
            if (Array.isArray(targets) && targets.length > 0) {
              wakeBtn.title = `Sent Wake-on-LAN to ${targets.join(', ')}`;
            }
          } catch (err) {
            if (labelSpan) labelSpan.textContent = 'Failed';
            wakeBtn.title = `Wake-on-LAN failed: ${err}`;
            console.warn('Wake-on-LAN failed:', err);
          } finally {
            setTimeout(() => {
              if (labelSpan) labelSpan.textContent = origLabel;
              wakeBtn.disabled = false;
            }, 1800);
          }
        });
      }

      card.querySelector('.btn-edit-saved').addEventListener('click', (e) => {
        e.stopPropagation();
        populateFormFromMachine(machine);
        setEditingMachine(machine.id);
        pcFriendlyInput.focus();
      });

      card.querySelector('.btn-delete-saved').addEventListener('click', (e) => {
        e.stopPropagation();
        state.savedMachines = state.savedMachines.filter((m) => m.id !== machine.id);
        persistSavedMachines(state.savedMachines);
        if (editingMachineId === machine.id) {
          clearEditMode();
        } else {
          renderSavedMachines(searchInput.value);
        }
      });

      card.querySelector('.btn-launch-card').addEventListener('click', () => {
        const passToUse = machine.password || customPassInput.value;
        if (!passToUse) {
          // Populate form in edit mode and focus password field so user can enter password & connect
          populateFormFromMachine(machine);
          setEditingMachine(machine.id);
          customPassInput.focus();
          return;
        }

        machine.lastConnected = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        persistSavedMachines(state.savedMachines);
        renderSavedMachines(searchInput.value);

        const cardNick = machine.nickname || (machine.name !== machine.ip ? machine.name : '');
        spawnSession({
          savedMachineId: machine.id,
          host: machine.ip,
          port: machine.port,
          user: machine.user,
          password: passToUse,
          domain: machine.domain || null,
          enableNla: machine.enableNla !== false,
          enableMic: machine.enableMic !== false,
          enableAudio: machine.audioOut ? machine.audioOut !== 'mute' : true,
          enableCamera: machine.enableCamera !== false,
          enableClipboard: machine.enableClipboard !== false,
          keyMap: machine.keyMap || null,
          macAddress: machine.macAddress || '',
          wolBroadcast: machine.wolBroadcast || '',
          wakeOnConnect: Boolean(machine.wakeOnConnect),
          nickname: cardNick,
          resolution: machine.resolution || '1920x1080',
          scale: '1x FHD'
        });
      });

      savedGrid.appendChild(card);
    });

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  searchInput.addEventListener('input', (e) => renderSavedMachines(e.target.value));

  async function waitForRdpPortWithWol(tab, host, port) {
    if (!isTauri || !tab.wakeOnConnect || !tab.macAddress) return true;
    const numericPort = Number(port) || 3389;
    const alreadyUp = await invoke('probe_tcp_port', { host, port: numericPort }).catch(() => false);
    if (alreadyUp) return true;

    if (state.activeTabId === tab.id) {
      connectingSubtext.textContent = `Sending Wake-on-LAN packet to ${tab.macAddress}...`;
    }
    await invoke('wake_on_lan', {
      mac: tab.macAddress,
      broadcastIp: tab.wolBroadcast || null,
      port: 9
    });

    const maxAttempts = 24;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!state.tabs.some((t) => t.id === tab.id)) {
        return false;
      }
      if (state.activeTabId === tab.id) {
        connectingSubtext.textContent = `Waiting for ${host}:${numericPort} to wake up (${attempt}/${maxAttempts})...`;
      }
      const reachable = await invoke('probe_tcp_port', { host, port: numericPort }).catch(() => false);
      if (reachable) return true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return state.tabs.some((t) => t.id === tab.id);
  }

  async function spawnSession({
    savedMachineId = null,
    host,
    port,
    user,
    password = '',
    domain = null,
    enableNla = true,
    enableMic = true,
    enableAudio = true,
    enableCamera = true,
    enableClipboard = true,
    keyMap = null,
    macAddress = '',
    wolBroadcast = '',
    wakeOnConnect = false,
    nickname,
    resolution,
    scale
  }) {
    const newTabId = `tab-${Date.now()}`;
    const cleanNick = (nickname || '').trim();
    const displayTitle = cleanNick || `${user} @ ${host}`;
    const tooltip = cleanNick ? `${cleanNick} (${user}@${host}:${port})` : `${user}@${host}:${port}`;
    const { width, height } = parseResolution(resolution);
    const resolvedRes = `${width}x${height}`;

    const newSession = {
      id: newTabId,
      backendSessionId: null,
      savedMachineId,
      type: 'session',
      title: displayTitle,
      tooltip,
      nickname: cleanNick,
      host,
      port,
      user,
      domain,
      password,
      rawResolution: resolution,
      resolution: resolvedRes,
      scale,
      enableNla,
      enableMic,
      enableAudio,
      enableCamera,
      enableClipboard,
      keyMap,
      macAddress,
      wolBroadcast,
      wakeOnConnect,
      status: 'connecting',
      isDetached: false,
      errorMessage: null,
      fps: 60
    };

    state.tabs.push(newSession);
    connectingSubtext.textContent = `Negotiating TLS & NLA handshake with ${host}:${port}...`;
    activateTab(newTabId);

    try {
      const shouldContinue = await waitForRdpPortWithWol(newSession, host, port);
      if (!shouldContinue) return;
      if (state.activeTabId === newTabId) {
        connectingSubtext.textContent = `Negotiating TLS & NLA handshake with ${host}:${port}...`;
      }

      const dto = await invoke('connect_session', {
        options: {
          host,
          port: Number(port) || 3389,
          username: user,
          password: password || '',
          domain: domain || null,
          width,
          height,
          enable_nla: Boolean(enableNla),
          enable_mic: Boolean(enableMic),
          enable_audio: Boolean(enableAudio),
          enable_camera: Boolean(enableCamera),
          enable_clipboard: Boolean(enableClipboard)
        }
      });
      if (dto && dto.id) {
        newSession.backendSessionId = dto.id;
        ensureStreamForTab(newSession);
      }
    } catch (err) {
      newSession.status = 'error';
      newSession.errorMessage = String(err);
      if (state.activeTabId === newTabId) {
        syncActiveTabView(newSession);
        renderTabs();
      }
    }
  }

  // Poll backend session status in Tauri
  if (isTauri && !new URLSearchParams(window.location.search).get('detached')) {
    setInterval(async () => {
      try {
        const backendSessions = await invoke('list_sessions');
        if (!Array.isArray(backendSessions)) return;

        let changed = false;
        backendSessions.forEach((bs) => {
          let tab = state.tabs.find((t) => Number(t.backendSessionId) === Number(bs.id));

          // Adopt any backend session not yet in state.tabs
          if (!tab) {
            tab = {
              id: `tab-backend-${bs.id}`,
              backendSessionId: bs.id,
              type: 'session',
              title: `${bs.username} @ ${bs.host}`,
              host: bs.host,
              port: bs.port,
              user: bs.username,
              resolution: `${bs.width}x${bs.height}`,
              scale: '1x FHD',
              status: 'connecting',
              isDetached: bs.is_detached,
              errorMessage: null,
              fps: 60
            };
            state.tabs.push(tab);
            changed = true;
          }

          // Update negotiated resolution if changed
          const negotiatedRes = `${bs.width}x${bs.height}`;
          if (bs.width && bs.height && tab.resolution !== negotiatedRes) {
            tab.resolution = negotiatedRes;
          }

          // Sync detached state
          if (tab.isDetached !== bs.is_detached) {
            tab.isDetached = bs.is_detached;
            changed = true;
            if (!tab.isDetached) {
              activateTab(tab.id);
            }
          }

          // Sync connection status
          let nextStatus = 'connecting';
          if (bs.status.startsWith('Connected')) {
            nextStatus = 'connected';
          } else if (bs.status.startsWith('Error:')) {
            nextStatus = 'error';
            tab.errorMessage = bs.status.replace(/^Error:\s*/, '');
          } else if (bs.status === 'Disconnected') {
            nextStatus = 'error';
            tab.errorMessage = 'The remote host closed the RDP session.';
          }

          if (tab.status !== nextStatus) {
            tab.status = nextStatus;
            changed = true;
            if (state.activeTabId === tab.id) {
              syncActiveTabView(tab);
            }
          }
        });

        if (changed) {
          renderTabs();
        }
      } catch (_) {}
    }, 300);
  }

  // Listen for cross-window dock events
  window.addEventListener('storage', (e) => {
    if (e.key === 'viewport_dock_event' && e.newValue) {
      try {
        const data = JSON.parse(e.newValue);
        const tab = state.tabs.find(
          (t) => t.id === data.tabId || String(t.backendSessionId) === String(data.sessionId)
        );
        if (tab) {
          tab.isDetached = false;
          renderTabs();
          activateTab(tab.id);
        }
      } catch (_) {}
    }
  });

  /* ==========================================================================
     6. Detached Window & Top Bar Controls
     ========================================================================== */
  async function enterDetachedMode(tabId) {
    const activeTab = state.tabs.find((t) => t.id === tabId);
    if (!activeTab || activeTab.type !== 'session' || !activeTab.backendSessionId) return;

    if (isTauri && !state.standaloneDetachedSessionId) {
      const sid = activeTab.backendSessionId;
      activeTab.isDetached = true;

      const query = new URLSearchParams({
        tabId: activeTab.id,
        title: activeTab.title,
        host: activeTab.host,
        port: String(activeTab.port || 3389),
        user: activeTab.user,
        resolution: activeTab.resolution || '1920x1080',
        scale: activeTab.scale || '1x FHD',
        keyMap: activeTab.keyMap ? JSON.stringify(activeTab.keyMap) : ''
      }).toString();

      try {
        await invoke('detach_tab', {
          sessionId: Number(sid),
          title: `ViewPort — ${activeTab.title}`,
          query
        });

        const remaining = state.tabs.filter((t) => !t.isDetached && t.id !== tabId);
        activateTab(remaining.length > 0 ? remaining[remaining.length - 1].id : 'tab-dashboard');
        return;
      } catch (err) {
        console.warn('Fallback to in-window detached mode:', err);
        activeTab.isDetached = false;
      }
    }

    activateTab(tabId);
    state.detachedWindowMode = true;
    appWindow.classList.add('detached-mode');
    mainChrome.classList.add('hidden');
    detachedChrome.classList.remove('hidden');
    document.getElementById('detached-session-label').textContent = activeTab.title;
  }

  async function exitDetachedMode() {
    if (state.standaloneDetachedSessionId && isTauri) {
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      try {
        localStorage.setItem(
          'viewport_dock_event',
          JSON.stringify({
            sessionId: state.standaloneDetachedSessionId,
            tabId: activeTab ? activeTab.id : null,
            ts: Date.now()
          })
        );
      } catch (_) {}
      await invoke('dock_tab', { sessionId: Number(state.standaloneDetachedSessionId) });
      return;
    }

    state.detachedWindowMode = false;
    appWindow.classList.remove('detached-mode');
    detachedChrome.classList.add('hidden');
    mainChrome.classList.remove('hidden');
    renderTabs();
  }

  document.getElementById('btn-dock-back').addEventListener('click', exitDetachedMode);
  document.getElementById('btn-detached-close').addEventListener('click', () => closeTab(state.activeTabId));

  async function toggleFullscreen() {
    if (isTauri) {
      try {
        await invoke('toggle_fullscreen', {});
        return;
      } catch (_) {}
    }
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  document.getElementById('tl-fullscreen-btn').addEventListener('click', toggleFullscreen);
  document.getElementById('btn-detached-fullscreen').addEventListener('click', toggleFullscreen);

  const btnErrorWake = document.getElementById('btn-error-wake');
  if (btnErrorWake) {
    btnErrorWake.addEventListener('click', async () => {
      const target = state.tabs.find((t) => t.id === state.activeTabId);
      if (!target || !target.macAddress || !isTauri) return;
      const span = btnErrorWake.querySelector('span');
      if (span) span.textContent = 'Waking...';
      btnErrorWake.disabled = true;
      try {
        await invoke('wake_on_lan', {
          mac: target.macAddress,
          broadcastIp: target.wolBroadcast || null,
          port: 9
        });
        const numericPort = Number(target.port) || 3389;
        for (let i = 0; i < 20; i++) {
          if (state.activeTabId !== target.id) return;
          const up = await invoke('probe_tcp_port', { host: target.host, port: numericPort }).catch(() => false);
          if (up) {
            document.getElementById('btn-error-retry').click();
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (span) span.textContent = 'Packet Sent';
      } catch (err) {
        if (span) span.textContent = 'Wake Failed';
        console.warn('Error modal Wake-on-LAN failed:', err);
      } finally {
        setTimeout(() => {
          if (span) span.textContent = 'Wake Host';
          btnErrorWake.disabled = false;
        }, 1800);
      }
    });
  }

  document.getElementById('btn-error-retry').addEventListener('click', async () => {
    const target = state.tabs.find((t) => t.id === state.activeTabId);
    if (!target || !target.backendSessionId) return;
    errorModal.classList.add('hidden');
    target.status = 'connecting';
    connectingOverlay.classList.remove('hidden');
    renderTabs();

    try {
      await invoke('reconnect_session', { sessionId: Number(target.backendSessionId) });
    } catch (err) {
      target.status = 'error';
      target.errorMessage = String(err);
      syncActiveTabView(target);
      renderTabs();
    }
  });

  document.getElementById('btn-error-edit').addEventListener('click', async () => {
    const target = state.tabs.find((t) => t.id === state.activeTabId);
    errorModal.classList.add('hidden');

    if (target) {
      const savedMachine =
        (target.savedMachineId && state.savedMachines.find((m) => m.id === target.savedMachineId)) ||
        state.savedMachines.find(
          (m) =>
            m.ip === target.host &&
            Number(m.port || 3389) === Number(target.port || 3389) &&
            m.user === target.user
        );

      await closeTab(target.id);
      activateTab('tab-dashboard');

      if (savedMachine) {
        populateFormFromMachine(savedMachine);
        setEditingMachine(savedMachine.id);
      } else if (target.host) {
        setEditingMachine(null);
        pcFriendlyInput.value = target.nickname || '';
        pcNameInput.value =
          target.port && Number(target.port) !== 3389 ? `${target.host}:${target.port}` : target.host;
        customUserInput.value = target.domain ? `${target.domain}\\${target.user}` : target.user || '';
        customPassInput.value = target.password || '';
        if (target.rawResolution) pcResolutionSelect.value = target.rawResolution;
        if (chkNla) chkNla.checked = target.enableNla !== false;
        if (chkMic) chkMic.checked = target.enableMic !== false;
        if (chkCamera) chkCamera.checked = target.enableCamera !== false;
        if (chkClipboard) chkClipboard.checked = target.enableClipboard !== false;
        if (pcAudioOut) pcAudioOut.value = target.enableAudio === false ? 'mute' : 'local';
        if (pcMacInput) pcMacInput.value = target.macAddress || '';
        if (pcWolBroadcastInput) pcWolBroadcastInput.value = target.wolBroadcast || '';
        if (chkWolConnect) chkWolConnect.checked = Boolean(target.wakeOnConnect);
        applyKeyMapToForm(target.keyMap);
      }
    } else {
      activateTab('tab-dashboard');
    }

    customPassInput.focus();
  });

  document.getElementById('ctx-cad-btn').addEventListener('click', () => {
    const targetId = contextMenuTabId || state.activeTabId;
    closeTabContextMenu();
    if (targetId && targetId !== state.activeTabId) {
      activateTab(targetId);
    }
    if (state.activeStream) {
      state.activeStream.sendCtrlAltDel();
    }
  });

  document.getElementById('ctx-detach-btn').addEventListener('click', () => {
    const targetId = contextMenuTabId || state.activeTabId;
    closeTabContextMenu();
    if (targetId) {
      state.detachedWindowMode ? exitDetachedMode() : enterDetachedMode(targetId);
    }
  });

  document.getElementById('ctx-fullscreen-btn').addEventListener('click', () => {
    const targetId = contextMenuTabId || state.activeTabId;
    closeTabContextMenu();
    if (targetId && targetId !== state.activeTabId) {
      activateTab(targetId);
    }
    toggleFullscreen();
  });

  document.getElementById('ctx-disconnect-btn').addEventListener('click', () => {
    const targetId = contextMenuTabId || state.activeTabId;
    closeTabContextMenu();
    if (targetId) closeTab(targetId);
  });

  document.addEventListener('mousedown', (e) => {
    if (tabContextMenu && !tabContextMenu.classList.contains('hidden') && !e.target.closest('#tab-context-menu')) {
      closeTabContextMenu();
    }
  });

  window.addEventListener('blur', closeTabContextMenu);
  window.addEventListener('resize', closeTabContextMenu);

  /* ==========================================================================
     7. Canvas Input Capture
     ========================================================================== */
  function captureCanvasInput() {
    state.canvasInputCaptured = true;
    rdpCanvas.classList.add('captured');
  }

  function releaseCanvasInput() {
    state.canvasInputCaptured = false;
    rdpCanvas.classList.remove('captured');
  }

  rdpCanvas.addEventListener('mousedown', () => {
    rdpCanvas.focus();
    captureCanvasInput();
  });

  rdpCanvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    return false;
  });

  window.addEventListener('keydown', (e) => {
    const canvasHasFocus = state.canvasInputCaptured || document.activeElement === rdpCanvas;
    if (!canvasHasFocus && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!state.detachedWindowMode) {
        activateTab('tab-dashboard');
        searchInput.focus();
      }
      return;
    }
    if (!canvasHasFocus && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
      e.preventDefault();
      if (!state.detachedWindowMode) {
        activateTab('tab-dashboard');
        pcNameInput.focus();
        pcNameInput.select();
      }
      return;
    }
    if (e.key === 'Escape') {
      closeTabContextMenu();
      if (state.canvasInputCaptured) {
        releaseCanvasInput();
      }
    }
  });

  /* ==========================================================================
     8. Initialization (Main Window vs. Standalone Detached OS Window)
     ========================================================================== */
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
    appWindow.classList.add('detached-mode');
    mainChrome.classList.add('hidden');
    detachedChrome.classList.remove('hidden');
    document.getElementById('detached-session-label').textContent = detachedTab.title;

    activateTab(detachedTab.id);
  } else {
    renderTabs();
    renderSavedMachines();
    activateTab('tab-dashboard');
  }
});
