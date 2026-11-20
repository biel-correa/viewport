/**
 * Session lifecycle, tab strip & drag-reorder, context menu, detached windows,
 * RDP canvas streaming, Wake-on-LAN pre-connect, error modal, and keyboard shortcuts.
 */

import { RdpCanvasStream } from './canvas.js';
import { isTauri, invoke } from './tauri.js';
import { DOCK_EVENT_KEY } from './state.js';
import { escapeHtml, formatPing, parseResolution } from './utils.js';

export function createSessionController({ state, dom, onEditFromError }) {
  let draggedTabId = null;
  let contextMenuTabId = null;

  function closeTabContextMenu() {
    contextMenuTabId = null;
    if (dom.tabContextMenu) dom.tabContextMenu.classList.add('hidden');
  }

  function openTabContextMenu(tab, clientX, clientY) {
    if (!dom.tabContextMenu) return;
    contextMenuTabId = tab.id;
    if (dom.ctxTabTitle) dom.ctxTabTitle.textContent = tab.title;
    if (dom.ctxTabQuality) {
      dom.ctxTabQuality.textContent = `${(tab.resolution || '1920x1080').replace('x', '×')} • ${tab.scale || '1x FHD'}`;
    }

    dom.tabContextMenu.classList.remove('hidden');
    const rect = dom.tabContextMenu.getBoundingClientRect();
    const x = Math.min(clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(clientY, window.innerHeight - rect.height - 8);
    dom.tabContextMenu.style.left = `${Math.max(8, x)}px`;
    dom.tabContextMenu.style.top = `${Math.max(8, y)}px`;
  }

  function captureCanvasInput() {
    state.canvasInputCaptured = true;
    dom.rdpCanvas.classList.add('captured');
  }

  function releaseCanvasInput() {
    state.canvasInputCaptured = false;
    dom.rdpCanvas.classList.remove('captured');
  }

  function updateTelemetryDisplay(tab) {
    const resText = (tab.resolution || '1920x1080').replace('x', '×');
    const fpsText = `${tab.fps ?? 60} FPS`;
    const pingText = formatPing(tab.pingMs);
    if (dom.telemetryRes) dom.telemetryRes.textContent = resText;
    if (dom.telemetryFps) dom.telemetryFps.textContent = fpsText;
    if (dom.telemetryPing) dom.telemetryPing.textContent = pingText;
    if (dom.detachedTelemetryLabel) {
      dom.detachedTelemetryLabel.textContent = `${resText} • ${fpsText} • ${pingText}`;
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

    if (state.activeStream && Number(state.activeStream.sessionId) === Number(tab.backendSessionId)) {
      return;
    }

    if (state.activeStream) {
      state.activeStream.destroy();
      state.activeStream = null;
    }

    const { width, height } = parseResolution(tab.resolution, dom.workspaceEl);
    const ctx = dom.rdpCanvas.getContext('2d', { alpha: false });
    dom.rdpCanvas.width = width;
    dom.rdpCanvas.height = height;
    ctx.fillStyle = '#040507';
    ctx.fillRect(0, 0, width, height);

    state.activeStream = new RdpCanvasStream(
      dom.rdpCanvas,
      tab.backendSessionId,
      state.streamPort,
      {
        width,
        height,
        swapMouse: dom.chkSwapMouse && dom.chkSwapMouse.checked,
        dynamicResize: dom.chkDynamicRes ? dom.chkDynamicRes.checked : true,
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

  function renderTabs() {
    if (!dom.tabStrip) return;
    dom.tabStrip.innerHTML = '';

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
      const actionsHtml =
        tab.type === 'session'
          ? `
          <div class="tab-actions">
            <button class="tab-act-btn detach" data-action="detach" title="Detach session into standalone window">⧉</button>
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

      dom.tabStrip.appendChild(tabEl);
    });
  }

  function syncActiveTabView(activeTab) {
    if (!activeTab) return;

    if (activeTab.type === 'dashboard') {
      dom.dashboardView.classList.remove('hidden');
      dom.sessionView.classList.add('hidden');
      dom.telemetryBadge.classList.add('hidden');
      releaseCanvasInput();
      if (state.activeStream) {
        state.activeStream.destroy();
        state.activeStream = null;
      }
    } else {
      dom.dashboardView.classList.add('hidden');
      dom.sessionView.classList.remove('hidden');
      dom.telemetryBadge.classList.remove('hidden');

      updateTelemetryDisplay(activeTab);
      if (dom.errorHostLabel) {
        dom.errorHostLabel.textContent = `${activeTab.host}:${activeTab.port || 3389}`;
      }
      if (dom.errorReconnectLabel) {
        dom.errorReconnectLabel.textContent =
          dom.chkReconnect && dom.chkReconnect.checked ? 'Enabled' : 'Disabled';
      }

      if (activeTab.errorMessage && dom.errorDescription) {
        dom.errorDescription.textContent = activeTab.errorMessage;
      }

      if (activeTab.status === 'connecting') {
        dom.connectingOverlay.classList.remove('hidden');
        dom.errorModal.classList.add('hidden');
      } else if (activeTab.status === 'error') {
        dom.connectingOverlay.classList.add('hidden');
        dom.errorModal.classList.remove('hidden');
        if (dom.btnErrorWake) {
          dom.btnErrorWake.classList.toggle('hidden', !activeTab.macAddress);
        }
      } else {
        dom.connectingOverlay.classList.add('hidden');
        dom.errorModal.classList.add('hidden');
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

  async function waitForRdpPortWithWol(tab, host, port) {
    if (!isTauri || !tab.wakeOnConnect || !tab.macAddress) return true;
    const numericPort = Number(port) || 3389;
    const alreadyUp = await invoke('probe_tcp_port', { host, port: numericPort }).catch(() => false);
    if (alreadyUp) return true;

    if (state.activeTabId === tab.id) {
      dom.connectingSubtext.textContent = `Sending Wake-on-LAN packet to ${tab.macAddress}...`;
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
        dom.connectingSubtext.textContent = `Waiting for ${host}:${numericPort} to wake up (${attempt}/${maxAttempts})...`;
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
    const { width, height } = parseResolution(resolution, dom.workspaceEl);
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
    dom.connectingSubtext.textContent = `Negotiating TLS & NLA handshake with ${host}:${port}...`;
    activateTab(newTabId);

    try {
      const shouldContinue = await waitForRdpPortWithWol(newSession, host, port);
      if (!shouldContinue) return;
      if (state.activeTabId === newTabId) {
        dom.connectingSubtext.textContent = `Negotiating TLS & NLA handshake with ${host}:${port}...`;
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
    dom.appWindow.classList.add('detached-mode');
    dom.mainChrome.classList.add('hidden');
    dom.detachedChrome.classList.remove('hidden');
    if (dom.detachedSessionLabel) dom.detachedSessionLabel.textContent = activeTab.title;
  }

  async function exitDetachedMode() {
    if (state.standaloneDetachedSessionId && isTauri) {
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      try {
        localStorage.setItem(
          DOCK_EVENT_KEY,
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
    dom.appWindow.classList.remove('detached-mode');
    dom.detachedChrome.classList.add('hidden');
    dom.mainChrome.classList.remove('hidden');
    renderTabs();
  }

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

  function startSessionStatusPolling() {
    if (!isTauri) return;
    setInterval(async () => {
      try {
        const backendSessions = await invoke('list_sessions');
        if (!Array.isArray(backendSessions)) return;

        let changed = false;
        backendSessions.forEach((bs) => {
          let tab = state.tabs.find((t) => Number(t.backendSessionId) === Number(bs.id));

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

          const negotiatedRes = `${bs.width}x${bs.height}`;
          if (bs.width && bs.height && tab.resolution !== negotiatedRes) {
            tab.resolution = negotiatedRes;
          }

          if (tab.isDetached !== bs.is_detached) {
            tab.isDetached = bs.is_detached;
            changed = true;
            if (!tab.isDetached) {
              activateTab(tab.id);
            }
          }

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

  // Bind UI & window listeners
  window.addEventListener('storage', (e) => {
    if (e.key === DOCK_EVENT_KEY && e.newValue) {
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

  if (dom.btnDockBack) dom.btnDockBack.addEventListener('click', exitDetachedMode);
  if (dom.btnDetachedClose) {
    dom.btnDetachedClose.addEventListener('click', () => closeTab(state.activeTabId));
  }
  if (dom.tlFullscreenBtn) dom.tlFullscreenBtn.addEventListener('click', toggleFullscreen);
  if (dom.btnDetachedFullscreen) dom.btnDetachedFullscreen.addEventListener('click', toggleFullscreen);

  if (dom.btnErrorWake) {
    dom.btnErrorWake.addEventListener('click', async () => {
      const target = state.tabs.find((t) => t.id === state.activeTabId);
      if (!target || !target.macAddress || !isTauri) return;
      const span = dom.btnErrorWake.querySelector('span');
      if (span) span.textContent = 'Waking...';
      dom.btnErrorWake.disabled = true;
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
            if (dom.btnErrorRetry) dom.btnErrorRetry.click();
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
          dom.btnErrorWake.disabled = false;
        }, 1800);
      }
    });
  }

  if (dom.btnErrorRetry) {
    dom.btnErrorRetry.addEventListener('click', async () => {
      const target = state.tabs.find((t) => t.id === state.activeTabId);
      if (!target || !target.backendSessionId) return;
      dom.errorModal.classList.add('hidden');
      target.status = 'connecting';
      dom.connectingOverlay.classList.remove('hidden');
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
  }

  if (dom.btnErrorEdit) {
    dom.btnErrorEdit.addEventListener('click', async () => {
      const target = state.tabs.find((t) => t.id === state.activeTabId);
      dom.errorModal.classList.add('hidden');

      if (target) {
        await closeTab(target.id);
      }
      activateTab('tab-dashboard');
      if (target) {
        onEditFromError(target);
      }
      if (dom.customPassInput) dom.customPassInput.focus();
    });
  }

  if (dom.ctxCadBtn) {
    dom.ctxCadBtn.addEventListener('click', () => {
      const targetId = contextMenuTabId || state.activeTabId;
      closeTabContextMenu();
      if (targetId && targetId !== state.activeTabId) activateTab(targetId);
      if (state.activeStream) state.activeStream.sendCtrlAltDel();
    });
  }

  if (dom.ctxDetachBtn) {
    dom.ctxDetachBtn.addEventListener('click', () => {
      const targetId = contextMenuTabId || state.activeTabId;
      closeTabContextMenu();
      if (targetId) {
        state.detachedWindowMode ? exitDetachedMode() : enterDetachedMode(targetId);
      }
    });
  }

  if (dom.ctxFullscreenBtn) {
    dom.ctxFullscreenBtn.addEventListener('click', () => {
      const targetId = contextMenuTabId || state.activeTabId;
      closeTabContextMenu();
      if (targetId && targetId !== state.activeTabId) activateTab(targetId);
      toggleFullscreen();
    });
  }

  if (dom.ctxDisconnectBtn) {
    dom.ctxDisconnectBtn.addEventListener('click', () => {
      const targetId = contextMenuTabId || state.activeTabId;
      closeTabContextMenu();
      if (targetId) closeTab(targetId);
    });
  }

  document.addEventListener('mousedown', (e) => {
    if (
      dom.tabContextMenu &&
      !dom.tabContextMenu.classList.contains('hidden') &&
      !e.target.closest('#tab-context-menu')
    ) {
      closeTabContextMenu();
    }
  });

  window.addEventListener('blur', closeTabContextMenu);
  window.addEventListener('resize', closeTabContextMenu);

  if (dom.rdpCanvas) {
    dom.rdpCanvas.addEventListener('mousedown', () => {
      dom.rdpCanvas.focus();
      captureCanvasInput();
    });

    dom.rdpCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      return false;
    });
  }

  window.addEventListener('keydown', (e) => {
    const canvasHasFocus = state.canvasInputCaptured || document.activeElement === dom.rdpCanvas;
    if (!canvasHasFocus && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!state.detachedWindowMode) {
        activateTab('tab-dashboard');
        dom.searchInput.focus();
      }
      return;
    }
    if (!canvasHasFocus && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
      e.preventDefault();
      if (!state.detachedWindowMode) {
        activateTab('tab-dashboard');
        dom.pcNameInput.focus();
        dom.pcNameInput.select();
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

  return {
    renderTabs,
    activateTab,
    closeTab,
    spawnSession,
    startSessionStatusPolling
  };
}
