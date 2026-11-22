/**
 * Add / Edit Saved PC form controller (progressive disclosure, MAC detect, save & connect).
 */

import { DEFAULT_KEY_MAP } from './scancodes.js';
import { isTauri, invoke } from './tauri.js';
import { persistSavedMachines } from './state.js';
import { parseCredentials, parseHostAndPort } from './utils.js';
import { decodeRdpBuffer, parseRdpContent } from './rdp-file.js';

export function createConnectionFormController({
  state,
  dom,
  keymap,
  onSavedMachinesChange,
  onConnect
}) {
  if (dom.btnToggleAdvanced && dom.advancedContainer) {
    dom.btnToggleAdvanced.addEventListener('click', () => {
      const isExpanded = dom.btnToggleAdvanced.getAttribute('aria-expanded') === 'true';
      dom.btnToggleAdvanced.setAttribute('aria-expanded', String(!isExpanded));
      dom.advancedContainer.classList.toggle('hidden', isExpanded);
    });
  }

  dom.segmentedTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      dom.segmentedTabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      Object.entries(dom.tabPanes).forEach(([key, pane]) => {
        if (pane) pane.classList.toggle('hidden', key !== targetTab);
      });
    });
  });

  if (dom.pcGatewaySelect && dom.chkBypassGw && dom.lblBypassGw) {
    dom.pcGatewaySelect.addEventListener('change', () => {
      const hasGateway = dom.pcGatewaySelect.value !== 'none';
      dom.chkBypassGw.disabled = !hasGateway;
      dom.lblBypassGw.classList.toggle('disabled', !hasGateway);
    });
  }

  if (dom.chkRetina && dom.rdpCanvas) {
    dom.chkRetina.addEventListener('change', () => {
      dom.rdpCanvas.classList.toggle('pixelated', dom.chkRetina.checked);
    });
  }

  if (dom.chkDynamicRes) {
    dom.chkDynamicRes.addEventListener('change', () => {
      if (state.activeStream) {
        state.activeStream.dynamicResize = dom.chkDynamicRes.checked;
        if (dom.chkDynamicRes.checked) {
          state.activeStream.checkViewportResize();
        }
      }
    });
  }

  if (dom.btnDetectMac) {
    dom.btnDetectMac.addEventListener('click', async () => {
      const { host } = parseHostAndPort(dom.pcNameInput.value);
      if (!host) {
        dom.pcNameInput.focus();
        return;
      }
      if (!isTauri) return;
      const origText = dom.btnDetectMac.textContent;
      dom.btnDetectMac.textContent = '...';
      dom.btnDetectMac.disabled = true;
      const hadMac = Boolean(dom.pcMacInput && dom.pcMacInput.value.trim());
      try {
        // Trigger a brief TCP probe first so the OS refreshes its ARP entry if the host is online on LAN
        await invoke('probe_tcp_port', { host, port: 3389 }).catch(() => false);
        const mac = await invoke('detect_mac_address', { host });
        if (mac) {
          if (dom.pcMacInput) dom.pcMacInput.value = mac;
          if (!hadMac && dom.chkWolConnect) {
            dom.chkWolConnect.checked = true;
          }
          dom.btnDetectMac.textContent = 'Found';
        } else {
          dom.btnDetectMac.textContent = 'Not in ARP';
        }
      } catch (_) {
        dom.btnDetectMac.textContent = 'Error';
      } finally {
        setTimeout(() => {
          dom.btnDetectMac.textContent = origText;
          dom.btnDetectMac.disabled = false;
        }, 1400);
      }
    });
  }

  function resolveFormCredentials() {
    return parseCredentials(dom.customUserInput.value, dom.customPassInput.value);
  }

  function buildSavedMachineEntry(existingMachine = null) {
    const { host, port } = parseHostAndPort(dom.pcNameInput.value);
    const { username, password, domain } = resolveFormCredentials();
    const nickname = dom.pcFriendlyInput.value.trim();
    const group = dom.pcGroupSelect.value;
    const resolution = dom.pcResolutionSelect.value;

    return {
      id: existingMachine ? existingMachine.id : `srv-${Date.now()}`,
      nickname,
      name: nickname || host,
      ip: host,
      port,
      user: username,
      domain,
      password,
      enableNla: dom.chkNla ? dom.chkNla.checked : true,
      enableMic: dom.chkMic ? dom.chkMic.checked : true,
      enableCamera: dom.chkCamera ? dom.chkCamera.checked : true,
      enableClipboard: dom.chkClipboard ? dom.chkClipboard.checked : true,
      audioOut: dom.pcAudioOut ? dom.pcAudioOut.value : 'local',
      swapMouse: dom.chkSwapMouse ? dom.chkSwapMouse.checked : false,
      dynamicRes: dom.chkDynamicRes ? dom.chkDynamicRes.checked : true,
      retina: dom.chkRetina ? dom.chkRetina.checked : true,
      reconnect: dom.chkReconnect ? dom.chkReconnect.checked : true,
      colorDepth: dom.pcColorDepthSelect ? dom.pcColorDepthSelect.value : '32',
      keyMap: keymap.readKeyMapFromForm(),
      macAddress: dom.pcMacInput ? dom.pcMacInput.value.trim() : '',
      wolBroadcast: dom.pcWolBroadcastInput ? dom.pcWolBroadcastInput.value.trim() : '',
      wakeOnConnect: dom.chkWolConnect ? dom.chkWolConnect.checked : false,
      group,
      isServer: group.includes('Server'),
      lastConnected: existingMachine ? existingMachine.lastConnected : 'Saved',
      resolution
    };
  }

  function setEditingMachine(machineId) {
    state.editingMachineId = machineId;
    const isEditing = Boolean(machineId);
    if (dom.formCardTitle) dom.formCardTitle.textContent = isEditing ? 'Edit Saved PC' : 'Connect to PC';
    if (dom.btnSaveOnly) dom.btnSaveOnly.textContent = isEditing ? 'Update PC' : 'Save to PCs';
    if (dom.btnResetForm) dom.btnResetForm.textContent = isEditing ? 'Cancel' : 'Reset';
    onSavedMachinesChange();
  }

  function showImportStatus(message, variant = 'success') {
    if (!dom.rdpImportStatus) return;
    dom.rdpImportStatus.textContent = message;
    dom.rdpImportStatus.classList.remove('hidden', 'is-warning', 'is-error');
    if (variant === 'warning') dom.rdpImportStatus.classList.add('is-warning');
    if (variant === 'error') dom.rdpImportStatus.classList.add('is-error');
  }

  function hideImportStatus() {
    if (!dom.rdpImportStatus) return;
    dom.rdpImportStatus.classList.add('hidden');
    dom.rdpImportStatus.classList.remove('is-warning', 'is-error');
  }

  function ensureResolutionOption(resValue) {
    if (!dom.pcResolutionSelect || !resValue) return;
    const exists = Array.from(dom.pcResolutionSelect.options).some((opt) => opt.value === resValue);
    if (!exists && /^\d+x\d+$/.test(resValue)) {
      const opt = document.createElement('option');
      opt.value = resValue;
      opt.dataset.scale = 'Custom';
      opt.textContent = `Custom (${resValue.replace('x', ' × ')})`;
      dom.pcResolutionSelect.appendChild(opt);
    }
  }

  function populateFormFromMachine(machine) {
    dom.pcFriendlyInput.value = machine.nickname || (machine.name !== machine.ip ? machine.name : '');
    dom.pcNameInput.value = machine.port && machine.port !== 3389 ? `${machine.ip}:${machine.port}` : machine.ip;
    dom.customUserInput.value = machine.domain ? `${machine.domain}\\${machine.user}` : machine.user;
    dom.customPassInput.value = machine.password || '';
    if (machine.group) dom.pcGroupSelect.value = machine.group;
    if (machine.resolution) {
      ensureResolutionOption(machine.resolution);
      dom.pcResolutionSelect.value = machine.resolution;
    }
    if (dom.pcColorDepthSelect && machine.colorDepth) {
      dom.pcColorDepthSelect.value = String(machine.colorDepth);
    }
    if (dom.chkNla) dom.chkNla.checked = machine.enableNla !== false;
    if (dom.chkReconnect) dom.chkReconnect.checked = machine.reconnect !== false;
    if (dom.chkSwapMouse) dom.chkSwapMouse.checked = Boolean(machine.swapMouse);
    if (dom.chkDynamicRes) dom.chkDynamicRes.checked = machine.dynamicRes !== false;
    if (dom.chkRetina) dom.chkRetina.checked = machine.retina !== false;
    if (dom.pcAudioOut && machine.audioOut) dom.pcAudioOut.value = machine.audioOut;
    if (dom.chkClipboard) dom.chkClipboard.checked = machine.enableClipboard !== false;
    if (dom.chkMic) dom.chkMic.checked = machine.enableMic !== false;
    if (dom.chkCamera) dom.chkCamera.checked = machine.enableCamera !== false;
    if (dom.pcMacInput) dom.pcMacInput.value = machine.macAddress || '';
    if (dom.pcWolBroadcastInput) dom.pcWolBroadcastInput.value = machine.wolBroadcast || '';
    if (dom.chkWolConnect) dom.chkWolConnect.checked = Boolean(machine.wakeOnConnect);
    keymap.applyKeyMapToForm(machine.keyMap);
  }

  function populateFormFromSessionTab(tab) {
    setEditingMachine(null);
    dom.pcFriendlyInput.value = tab.nickname || '';
    dom.pcNameInput.value =
      tab.port && Number(tab.port) !== 3389 ? `${tab.host}:${tab.port}` : tab.host;
    dom.customUserInput.value = tab.domain ? `${tab.domain}\\${tab.user}` : tab.user || '';
    dom.customPassInput.value = tab.password || '';
    if (tab.rawResolution) dom.pcResolutionSelect.value = tab.rawResolution;
    if (dom.chkNla) dom.chkNla.checked = tab.enableNla !== false;
    if (dom.chkMic) dom.chkMic.checked = tab.enableMic !== false;
    if (dom.chkCamera) dom.chkCamera.checked = tab.enableCamera !== false;
    if (dom.chkClipboard) dom.chkClipboard.checked = tab.enableClipboard !== false;
    if (dom.pcAudioOut) dom.pcAudioOut.value = tab.enableAudio === false ? 'mute' : 'local';
    if (dom.pcMacInput) dom.pcMacInput.value = tab.macAddress || '';
    if (dom.pcWolBroadcastInput) dom.pcWolBroadcastInput.value = tab.wolBroadcast || '';
    if (dom.chkWolConnect) dom.chkWolConnect.checked = Boolean(tab.wakeOnConnect);
    keymap.applyKeyMapToForm(tab.keyMap);
  }

  function clearEditMode() {
    dom.addPcForm.reset();
    keymap.applyKeyMapToForm(DEFAULT_KEY_MAP);
    if (dom.chkBypassGw) dom.chkBypassGw.disabled = true;
    if (dom.lblBypassGw) dom.lblBypassGw.classList.add('disabled');
    hideImportStatus();
    setEditingMachine(null);
  }

  async function importRdpFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.name);
    if (files.length === 0) return;

    const imported = [];
    const errors = [];

    for (const file of files) {
      try {
        const buffer = await file.arrayBuffer();
        const text = decodeRdpBuffer(buffer);
        const parsed = parseRdpContent(text, file.name);
        imported.push({ fileName: file.name, ...parsed });
      } catch (err) {
        errors.push(`${file.name}: ${err.message || err}`);
      }
    }

    if (imported.length === 0) {
      showImportStatus(`Failed to import .rdp file — ${errors[0] || 'invalid file format.'}`, 'error');
      return;
    }

    // Single .rdp file: populate the form cleanly for immediate review, Save, or Connect
    if (imported.length === 1) {
      const { fileName, machine, warnings } = imported[0];
      setEditingMachine(null);
      populateFormFromMachine(machine);

      const summary =
        warnings.length > 0
          ? `Imported ${fileName}. ${warnings.join(' ')}`
          : `Imported ${fileName} — click Save to PCs or Connect.`;
      showImportStatus(summary, warnings.length > 0 ? 'warning' : 'success');

      if (!machine.user) {
        dom.customUserInput.focus();
      } else {
        dom.customPassInput.focus();
      }
      return;
    }

    // Multiple .rdp files: bulk-add/update directly into Saved PCs
    for (const { machine } of imported) {
      const existingIdx = state.savedMachines.findIndex(
        (m) => m.ip === machine.ip && Number(m.port || 3389) === Number(machine.port || 3389) && m.user === machine.user
      );
      if (existingIdx !== -1) {
        state.savedMachines[existingIdx] = {
          ...state.savedMachines[existingIdx],
          ...machine,
          id: state.savedMachines[existingIdx].id,
          password: state.savedMachines[existingIdx].password || ''
        };
      } else {
        state.savedMachines.unshift(machine);
      }
    }

    persistSavedMachines(state.savedMachines);
    onSavedMachinesChange();

    const statusMsg =
      errors.length > 0
        ? `Imported ${imported.length} .rdp files into Saved PCs (${errors.length} skipped).`
        : `Imported ${imported.length} .rdp files into Saved PCs.`;
    showImportStatus(statusMsg, errors.length > 0 ? 'warning' : 'success');
  }

  if (dom.btnImportRdp && dom.rdpFileInput) {
    dom.btnImportRdp.addEventListener('click', () => {
      dom.rdpFileInput.value = '';
      dom.rdpFileInput.click();
    });

    dom.rdpFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        importRdpFiles(e.target.files);
      }
    });
  }

  if (dom.addPcCard) {
    const hasFiles = (e) =>
      Boolean(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));

    dom.addPcCard.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      dom.addPcCard.classList.add('rdp-drag-over');
    });

    dom.addPcCard.addEventListener('dragleave', (e) => {
      if (!dom.addPcCard.contains(e.relatedTarget)) {
        dom.addPcCard.classList.remove('rdp-drag-over');
      }
    });

    dom.addPcCard.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dom.addPcCard.classList.remove('rdp-drag-over');
      const rdpFiles = Array.from(e.dataTransfer.files || []).filter((f) =>
        f.name.toLowerCase().endsWith('.rdp')
      );
      if (rdpFiles.length === 0) {
        showImportStatus('Drop a .rdp file to import connection settings.', 'warning');
        return;
      }
      importRdpFiles(rdpFiles);
    });
  }

  if (dom.btnSaveOnly) {
    dom.btnSaveOnly.addEventListener('click', () => {
      const { host, port } = parseHostAndPort(dom.pcNameInput.value);
      const { username } = resolveFormCredentials();
      if (!host || !username) {
        if (!host) dom.pcNameInput.focus();
        else dom.customUserInput.focus();
        return;
      }

      const existingIdx = state.editingMachineId
        ? state.savedMachines.findIndex((m) => m.id === state.editingMachineId)
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
      if (state.editingMachineId) {
        clearEditMode();
      } else {
        onSavedMachinesChange();
      }
    });
  }

  if (dom.btnResetForm) {
    dom.btnResetForm.addEventListener('click', clearEditMode);
  }

  if (dom.addPcForm) {
    dom.addPcForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const { host, port } = parseHostAndPort(dom.pcNameInput.value);
      const { username, password, domain } = resolveFormCredentials();
      if (!host || !username) return;

      const nickname = dom.pcFriendlyInput.value.trim();
      const selectedOpt = dom.pcResolutionSelect.options[dom.pcResolutionSelect.selectedIndex];
      const enableNla = dom.chkNla ? dom.chkNla.checked : true;
      const enableMic = dom.chkMic ? dom.chkMic.checked : true;
      const enableCamera = dom.chkCamera ? dom.chkCamera.checked : true;
      const enableClipboard = dom.chkClipboard ? dom.chkClipboard.checked : true;
      const enableAudio = dom.pcAudioOut ? dom.pcAudioOut.value !== 'mute' : true;

      const keyMap = keymap.readKeyMapFromForm();
      const resolution = dom.pcResolutionSelect.value;
      const macAddress = dom.pcMacInput ? dom.pcMacInput.value.trim() : '';
      const wolBroadcast = dom.pcWolBroadcastInput ? dom.pcWolBroadcastInput.value.trim() : '';
      const wakeOnConnect = dom.chkWolConnect ? dom.chkWolConnect.checked : false;
      const activeSavedId = state.editingMachineId;

      if (state.editingMachineId) {
        const idx = state.savedMachines.findIndex((m) => m.id === state.editingMachineId);
        if (idx !== -1) {
          state.savedMachines[idx] = buildSavedMachineEntry(state.savedMachines[idx]);
          persistSavedMachines(state.savedMachines);
        }
        clearEditMode();
      }

      onConnect({
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
  }

  return {
    setEditingMachine,
    populateFormFromMachine,
    populateFormFromSessionTab,
    clearEditMode
  };
}
