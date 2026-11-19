/**
 * ViewPort — macOS Remote Desktop Client (Vanilla ES6+)
 * Featuring Windows App "Add PC" Progressive Disclosure & Segmented Tabs
 */

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();

  /* ==========================================================================
     1. Application State & Mock Data
     ========================================================================== */
  const state = {
    activeTabId: 'tab-dashboard',
    detachedWindowMode: false,
    canvasInputCaptured: false,
    remoteCursor: { x: 640, y: 420 },
    remoteContextMenu: { visible: false, x: 0, y: 0 },
    cadFlashUntil: 0,
    tabs: [
      {
        id: 'tab-dashboard',
        type: 'dashboard',
        title: 'Dashboard',
        status: 'idle',
      },
      {
        id: 'tab-prod-win11',
        type: 'session',
        title: 'gabriel.correa @ 10.0.40.12',
        host: '10.0.40.12',
        port: 3389,
        user: 'gabriel.correa',
        group: 'Work Laptops',
        resolution: '2880x1800',
        scale: '2x HiDPI',
        status: 'connected',
        ping: 14,
        fps: 60
      }
    ],
    savedMachines: [
      {
        id: 'srv-1',
        name: 'Workstation-Win11-Dev',
        ip: '10.0.40.12',
        port: 3389,
        user: 'gabriel.correa',
        group: 'Work Laptops',
        isServer: false,
        lastConnected: '2 mins ago',
        resolution: '2880x1800'
      },
      {
        id: 'srv-2',
        name: 'BuildNode-Kestrel-01',
        ip: '192.168.1.50',
        port: 3389,
        user: 'Administrator',
        group: 'Production Servers',
        isServer: true,
        lastConnected: 'Yesterday, 21:14',
        resolution: '2560x1440'
      },
      {
        id: 'srv-3',
        name: 'Work-Laptop-Secondary',
        ip: '192.168.1.88',
        port: 3389,
        user: 'gabriel.correa',
        group: 'Work Laptops',
        isServer: false,
        lastConnected: '3 days ago',
        resolution: '2880x1800'
      },
      {
        id: 'srv-4',
        name: 'SQL-Core-Cluster02',
        ip: '10.0.99.210',
        port: 3389,
        user: 'sysadmin',
        group: 'Production Servers',
        isServer: true,
        lastConnected: 'Nov 12, 2026',
        resolution: '1920x1080'
      }
    ]
  };

  /* ==========================================================================
     2. DOM Element References
     ========================================================================== */
  const appWindow = document.getElementById('app');
  const mainChrome = document.getElementById('main-chrome');
  const detachedChrome = document.getElementById('detached-chrome');
  const tabStrip = document.getElementById('tab-strip');
  const telemetryBadge = document.getElementById('telemetry-badge');
  const telemetryPing = document.getElementById('telemetry-ping');
  const telemetryFps = document.getElementById('telemetry-fps');

  const dashboardView = document.getElementById('dashboard-view');
  const sessionView = document.getElementById('session-view');
  const savedGrid = document.getElementById('saved-grid');
  const savedCount = document.getElementById('saved-count');
  const searchInput = document.getElementById('search-hosts');

  // Windows App "Add PC" Form Elements
  const addPcForm = document.getElementById('add-pc-form');
  const pcNameInput = document.getElementById('pc-name');
  const pcCredentialsSelect = document.getElementById('pc-credentials');
  const customCredDrawer = document.getElementById('custom-cred-drawer');
  const customUserInput = document.getElementById('custom-user');
  const pcFriendlyInput = document.getElementById('pc-friendly');
  const pcGroupSelect = document.getElementById('pc-group');
  const pcGatewaySelect = document.getElementById('pc-gateway');
  const chkBypassGw = document.getElementById('chk-bypass-gw');
  const lblBypassGw = document.getElementById('lbl-bypass-gw');
  const pcResolutionSelect = document.getElementById('pc-resolution');

  const btnToggleAdvanced = document.getElementById('btn-toggle-advanced');
  const advancedContainer = document.getElementById('advanced-container');
  const segmentedTabs = document.querySelectorAll('.seg-tab');
  const tabPanes = {
    general: document.getElementById('tab-pane-general'),
    display: document.getElementById('tab-pane-display'),
    devices: document.getElementById('tab-pane-devices'),
    folders: document.getElementById('tab-pane-folders')
  };

  const rdpCanvas = document.getElementById('rdp-canvas');
  const ctx = rdpCanvas.getContext('2d');
  const floatingHud = document.getElementById('floating-hud');
  const hudTitle = document.getElementById('hud-title');
  const hudQuality = document.getElementById('hud-quality');
  const inputCaptureBadge = document.getElementById('input-capture-badge');

  const connectingOverlay = document.getElementById('connecting-overlay');
  const connectingSubtext = document.getElementById('connecting-subtext');
  const errorModal = document.getElementById('error-modal');
  const errorHostLabel = document.getElementById('error-host-label');

  let draggedTabId = null;

  /* ==========================================================================
     3. Windows App "Add PC" Interactions (Progressive Disclosure & Tabs)
     ========================================================================== */
  // Toggle Advanced Options (Hidden by default, shown on demand)
  btnToggleAdvanced.addEventListener('click', () => {
    const isExpanded = btnToggleAdvanced.getAttribute('aria-expanded') === 'true';
    btnToggleAdvanced.setAttribute('aria-expanded', String(!isExpanded));
    advancedContainer.classList.toggle('hidden', isExpanded);
  });

  // Switch between General | Display | Devices & Audio | Folders
  segmentedTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      segmentedTabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      Object.entries(tabPanes).forEach(([key, pane]) => {
        pane.classList.toggle('hidden', key !== targetTab);
      });
    });
  });

  // Credentials dropdown: Reveal inline username/password fields if "+ Add credentials..." is chosen
  pcCredentialsSelect.addEventListener('change', () => {
    const isCustom = pcCredentialsSelect.value === 'custom';
    customCredDrawer.classList.toggle('hidden', !isCustom);
    if (isCustom) customUserInput.focus();
  });

  // Gateway dropdown: Enable/disable "Bypass for local addresses" like Windows App
  pcGatewaySelect.addEventListener('change', () => {
    const hasGateway = pcGatewaySelect.value !== 'none';
    chkBypassGw.disabled = !hasGateway;
    lblBypassGw.classList.toggle('disabled', !hasGateway);
  });

  // Parse host:port helper
  function parseHostAndPort(rawHost) {
    const trimmed = rawHost.trim();
    if (trimmed.includes(':')) {
      const [h, p] = trimmed.split(':');
      return { host: h || '192.168.1.50', port: Number(p) || 3389 };
    }
    return { host: trimmed || '192.168.1.50', port: 3389 };
  }

  function resolveSelectedUser() {
    const val = pcCredentialsSelect.value;
    if (val === 'ask') return 'Prompt Auth';
    if (val === 'custom') return customUserInput.value.trim() || 'Administrator';
    return val;
  }

  // "Save to PCs" button adds card to Saved PCs grid without launching immediately
  document.getElementById('btn-save-only').addEventListener('click', () => {
    const { host, port } = parseHostAndPort(pcNameInput.value);
    const user = resolveSelectedUser();
    const friendly = pcFriendlyInput.value.trim() || `PC-${host}`;
    const group = pcGroupSelect.value;
    const res = pcResolutionSelect.value;

    state.savedMachines.unshift({
      id: `srv-${Date.now()}`,
      name: friendly,
      ip: host,
      port,
      user,
      group,
      isServer: group.includes('Server'),
      lastConnected: 'Just added',
      resolution: res
    });

    renderSavedMachines(searchInput.value);
  });

  // Reset Form button
  document.getElementById('btn-reset-form').addEventListener('click', () => {
    addPcForm.reset();
    customCredDrawer.classList.add('hidden');
    chkBypassGw.disabled = true;
    lblBypassGw.classList.add('disabled');
  });

  // Primary "Connect" submit
  addPcForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { host, port } = parseHostAndPort(pcNameInput.value);
    const user = resolveSelectedUser();
    const nickname = pcFriendlyInput.value.trim();
    const selectedOpt = pcResolutionSelect.options[pcResolutionSelect.selectedIndex];

    spawnSession({
      host,
      port,
      user,
      nickname,
      resolution: pcResolutionSelect.value,
      scale: selectedOpt.dataset.scale || '2x HiDPI'
    });
  });

  /* ==========================================================================
     4. Tab Strip Rendering & Drag-and-Drop Reordering
     ========================================================================== */
  function renderTabs() {
    tabStrip.innerHTML = '';

    state.tabs.forEach((tab) => {
      const tabEl = document.createElement('div');
      tabEl.className = `session-tab ${tab.id === state.activeTabId ? 'active' : ''}`;
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('draggable', 'true');
      tabEl.dataset.id = tab.id;

      const dotClass = tab.type === 'dashboard' ? 'idle' : tab.status;
      const actionsHtml = tab.type === 'session'
        ? `
          <div class="tab-actions">
            <button class="tab-act-btn detach" data-action="detach" title="Detach session into standalone window">⧉</button>
            <button class="tab-act-btn close" data-action="close" title="Disconnect & Close Tab">✕</button>
          </div>
        `
        : '';

      tabEl.innerHTML = `
        <span class="status-dot ${dotClass}"></span>
        <span class="tab-title ${tab.type === 'session' ? 'mono' : ''}">${tab.title}</span>
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
        const fromIdx = state.tabs.findIndex(t => t.id === draggedTabId);
        const toIdx = state.tabs.findIndex(t => t.id === tab.id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [moved] = state.tabs.splice(fromIdx, 1);
          state.tabs.splice(toIdx, 0, moved);
          renderTabs();
        }
      });

      tabStrip.appendChild(tabEl);
    });
  }

  function activateTab(tabId) {
    state.activeTabId = tabId;
    const activeTab = state.tabs.find(t => t.id === tabId);
    if (!activeTab) return;

    renderTabs();

    if (activeTab.type === 'dashboard') {
      dashboardView.classList.remove('hidden');
      sessionView.classList.add('hidden');
      telemetryBadge.classList.add('hidden');
      releaseCanvasInput();
    } else {
      dashboardView.classList.add('hidden');
      sessionView.classList.remove('hidden');
      telemetryBadge.classList.remove('hidden');

      hudTitle.textContent = activeTab.title;
      hudQuality.textContent = `⚡ ${activeTab.ping}ms • 48.2 Mbps • ${activeTab.scale || '2x HiDPI'}`;
      errorHostLabel.textContent = `${activeTab.host}:${activeTab.port || 3389}`;

      if (activeTab.status === 'connecting') {
        connectingOverlay.classList.remove('hidden');
        errorModal.classList.add('hidden');
      } else if (activeTab.status === 'error') {
        connectingOverlay.classList.add('hidden');
        errorModal.classList.remove('hidden');
      } else {
        connectingOverlay.classList.add('hidden');
        errorModal.classList.add('hidden');
      }
    }
  }

  function closeTab(tabId) {
    const idx = state.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    state.tabs.splice(idx, 1);

    if (state.detachedWindowMode) exitDetachedMode();

    if (state.activeTabId === tabId) {
      const fallback = state.tabs[idx - 1] || state.tabs[0];
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
      m =>
        m.name.toLowerCase().includes(query) ||
        m.ip.toLowerCase().includes(query) ||
        m.group.toLowerCase().includes(query)
    );

    savedCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'machine' : 'machines'}`;
    savedGrid.innerHTML = '';

    filtered.forEach((machine) => {
      const card = document.createElement('article');
      card.className = 'host-card';
      card.innerHTML = `
        <div class="host-card-top">
          <div class="os-badge ${machine.isServer ? 'server' : ''}">
            <i data-lucide="${machine.isServer ? 'database' : 'monitor'}"></i>
          </div>
          <div class="host-meta">
            <h3>${machine.name}</h3>
            <div class="host-ip mono">${machine.user}@${machine.ip}:${machine.port}</div>
          </div>
          <span class="host-group-tag">${machine.group}</span>
        </div>
        <div class="host-card-footer">
          <span class="last-seen">
            <i data-lucide="clock" class="icon-xs"></i>
            ${machine.lastConnected}
          </span>
          <button class="btn-launch-card" data-id="${machine.id}">
            <span>Connect</span>
            <i data-lucide="arrow-up-right" class="icon-xs"></i>
          </button>
        </div>
      `;

      card.querySelector('.btn-launch-card').addEventListener('click', () => {
        spawnSession({
          host: machine.ip,
          port: machine.port,
          user: machine.user,
          nickname: machine.name,
          resolution: machine.resolution,
          scale: '2x HiDPI'
        });
      });

      savedGrid.appendChild(card);
    });

    lucide.createIcons();
  }

  searchInput.addEventListener('input', (e) => renderSavedMachines(e.target.value));

  function spawnSession({ host, port, user, nickname, resolution, scale }) {
    const newTabId = `tab-${Date.now()}`;
    const displayTitle = nickname ? `${nickname} (${host})` : `${user} @ ${host}`;

    const newSession = {
      id: newTabId,
      type: 'session',
      title: displayTitle,
      host,
      port,
      user,
      resolution,
      scale,
      status: 'connecting',
      ping: Math.floor(Math.random() * 12) + 9,
      fps: 60
    };

    state.tabs.push(newSession);
    connectingSubtext.textContent = `Negotiating TLS & NLA handshake with ${host}:${port}...`;
    activateTab(newTabId);
    floatingHud.classList.add('visible');

    setTimeout(() => {
      const target = state.tabs.find(t => t.id === newTabId);
      if (!target) return;
      target.status = 'connected';
      if (state.activeTabId === newTabId) {
        connectingOverlay.classList.add('hidden');
        renderTabs();
      }
      setTimeout(() => floatingHud.classList.remove('visible'), 1800);
    }, 1250);
  }

  /* ==========================================================================
     6. Detached Window & Top Bar Controls
     ========================================================================== */
  function enterDetachedMode(tabId) {
    activateTab(tabId);
    const activeTab = state.tabs.find(t => t.id === tabId);
    if (!activeTab || activeTab.type !== 'session') return;

    state.detachedWindowMode = true;
    appWindow.classList.add('detached-mode');
    mainChrome.classList.add('hidden');
    detachedChrome.classList.remove('hidden');
    document.getElementById('detached-session-label').textContent = activeTab.title;
  }

  function exitDetachedMode() {
    state.detachedWindowMode = false;
    appWindow.classList.remove('detached-mode');
    detachedChrome.classList.add('hidden');
    mainChrome.classList.remove('hidden');
    renderTabs();
  }

  document.getElementById('btn-dock-back').addEventListener('click', exitDetachedMode);
  document.getElementById('hud-detach-btn').addEventListener('click', () => {
    state.detachedWindowMode ? exitDetachedMode() : enterDetachedMode(state.activeTabId);
  });
  document.getElementById('btn-detached-close').addEventListener('click', () => closeTab(state.activeTabId));

  document.getElementById('btn-new-tab').addEventListener('click', () => {
    activateTab('tab-dashboard');
    pcNameInput.focus();
    pcNameInput.select();
  });

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('tl-fullscreen-btn').addEventListener('click', toggleFullscreen);
  document.getElementById('hud-fullscreen-btn').addEventListener('click', toggleFullscreen);
  document.getElementById('btn-detached-fullscreen').addEventListener('click', toggleFullscreen);

  document.getElementById('btn-simulate-error').addEventListener('click', () => {
    let target = state.tabs.find(t => t.id === state.activeTabId);
    if (!target || target.type === 'dashboard') {
      const firstSession = state.tabs.find(t => t.type === 'session');
      if (!firstSession) return;
      activateTab(firstSession.id);
      target = firstSession;
    }
    target.status = 'error';
    renderTabs();
    errorHostLabel.textContent = `${target.host}:${target.port || 3389}`;
    errorModal.classList.remove('hidden');
  });

  document.getElementById('btn-error-retry').addEventListener('click', () => {
    const target = state.tabs.find(t => t.id === state.activeTabId);
    if (!target) return;
    errorModal.classList.add('hidden');
    target.status = 'connecting';
    connectingOverlay.classList.remove('hidden');
    renderTabs();

    setTimeout(() => {
      target.status = 'connected';
      connectingOverlay.classList.add('hidden');
      renderTabs();
    }, 1000);
  });

  document.getElementById('btn-error-edit').addEventListener('click', () => {
    errorModal.classList.add('hidden');
    activateTab('tab-dashboard');
    btnToggleAdvanced.setAttribute('aria-expanded', 'true');
    advancedContainer.classList.remove('hidden');
  });

  document.getElementById('hud-cad-btn').addEventListener('click', () => {
    state.cadFlashUntil = Date.now() + 2200;
  });

  document.getElementById('hud-disconnect-btn').addEventListener('click', () => closeTab(state.activeTabId));

  /* ==========================================================================
     7. Canvas Input Priority & Remote Windows 11 Desktop Renderer
     ========================================================================== */
  function captureCanvasInput() {
    state.canvasInputCaptured = true;
    rdpCanvas.classList.add('captured');
    inputCaptureBadge.classList.remove('hidden');
  }

  function releaseCanvasInput() {
    state.canvasInputCaptured = false;
    rdpCanvas.classList.remove('captured');
    inputCaptureBadge.classList.add('hidden');
  }

  rdpCanvas.addEventListener('mousedown', (e) => {
    rdpCanvas.focus();
    captureCanvasInput();

    const rect = rdpCanvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) * (rdpCanvas.width / rect.width);
    const clickY = (e.clientY - rect.top) * (rdpCanvas.height / rect.height);

    if (e.button === 2) {
      state.remoteContextMenu = { visible: true, x: clickX, y: clickY };
    } else {
      state.remoteContextMenu.visible = false;
    }
  });

  rdpCanvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    return false;
  });

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      activateTab('tab-dashboard');
      searchInput.focus();
      return;
    }
    if (e.key === 'Escape' && state.canvasInputCaptured) {
      releaseCanvasInput();
      state.remoteContextMenu.visible = false;
    }
  });

  function drawRemoteDesktop() {
    const w = rdpCanvas.width;
    const h = rdpCanvas.height;

    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, '#0a1124');
    bgGrad.addColorStop(0.5, '#0f2547');
    bgGrad.addColorStop(1, '#08101d');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    const winX = 240, winY = 140, winW = 920, winH = 520;
    ctx.fillStyle = 'rgba(18, 20, 28, 0.94)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(winX, winY, winW, winH, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#181B24';
    ctx.beginPath();
    ctx.roundRect(winX, winY, winW, 44, [12, 12, 0, 0]);
    ctx.fill();

    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    const hostLabel = activeTab?.host || '10.0.40.12';

    ctx.fillStyle = '#9CA3AF';
    ctx.font = '600 15px "JetBrains Mono", monospace';
    ctx.fillText(`Windows PowerShell — Connected to ${hostLabel}`, winX + 22, winY + 28);

    ctx.fillStyle = '#E5E7EB';
    ctx.font = '16px "JetBrains Mono", monospace';
    ctx.fillText(`PS C:\\Users\\${activeTab?.user || 'gabriel.correa'}> Get-RdpSessionInfo`, winX + 26, winY + 88);

    ctx.fillStyle = '#00A8FF';
    ctx.fillText(`Host            : ${hostLabel}:${activeTab?.port || 3389}`, winX + 26, winY + 130);
    ctx.fillText(`Display         : ${activeTab?.resolution || '2880x1800'} (${activeTab?.scale || '2x HiDPI'})`, winX + 26, winY + 162);
    ctx.fillStyle = '#10B981';
    ctx.fillText(`Auto-Reconnect  : Enabled (Windows App Profile)`, winX + 26, winY + 194);
    ctx.fillText(`Latency         : ${activeTab?.ping || 14} ms • 60 FPS`, winX + 26, winY + 226);

    // Windows 11 Taskbar
    ctx.fillStyle = 'rgba(15, 18, 26, 0.88)';
    ctx.fillRect(0, h - 54, w, 54);

    if (state.remoteContextMenu.visible) {
      const mx = Math.min(state.remoteContextMenu.x, w - 240);
      const my = Math.min(state.remoteContextMenu.y, h - 230);
      ctx.fillStyle = 'rgba(26, 29, 38, 0.96)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.beginPath();
      ctx.roundRect(mx, my, 220, 165, 8);
      ctx.fill();
      ctx.stroke();

      ['View', 'Sort by', 'Refresh', 'Open in Terminal', 'Display settings'].forEach((item, idx) => {
        ctx.fillStyle = '#F3F4F6';
        ctx.font = '14px -apple-system, sans-serif';
        ctx.fillText(item, mx + 18, my + 34 + idx * 30);
      });
    }

    if (Date.now() < state.cadFlashUntil) {
      ctx.fillStyle = 'rgba(0, 122, 255, 0.92)';
      ctx.beginPath();
      ctx.roundRect(w / 2 - 210, 80, 420, 44, 22);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '600 15px -apple-system, sans-serif';
      ctx.fillText('⚡ Sent Secure Attention Sequence (Ctrl+Alt+Del)', w / 2 - 175, 107);
    }

    requestAnimationFrame(drawRemoteDesktop);
  }

  renderTabs();
  renderSavedMachines();
  activateTab('tab-dashboard');
  requestAnimationFrame(drawRemoteDesktop);
});
