import { RdpCanvasStream } from './canvas.js';

class ViewPortApp {
  constructor() {
    this.streamPort = 0;
    this.sessions = [];
    this.activeTabId = 'new'; // 'new' or session_id (number)
    this.activeStream = null;

    // DOM Elements
    this.tabStrip = document.getElementById('tab-strip');
    this.newTabBtn = document.getElementById('new-tab-btn');
    this.dashboardView = document.getElementById('dashboard-view');
    this.canvasView = document.getElementById('canvas-view');
    this.canvas = document.getElementById('rdp-canvas');
    this.fpsBadge = document.getElementById('fps-badge');
    this.fullscreenBtn = document.getElementById('fullscreen-btn');
    this.connectForm = document.getElementById('connect-form');

    // HUD Elements
    this.hudSessionName = document.getElementById('hud-session-name');
    this.hudDetachBtn = document.getElementById('hud-detach-btn');
    this.hudFullscreenBtn = document.getElementById('hud-fullscreen-btn');
    this.hudDisconnectBtn = document.getElementById('hud-disconnect-btn');

    this.init();
  }

  async init() {
    try {
      if (window.__TAURI__ && window.__TAURI__.core) {
        this.streamPort = await window.__TAURI__.core.invoke('get_stream_port');
        console.log('RDP Stream server port:', this.streamPort);
      }
    } catch (e) {
      console.warn('Could not retrieve stream port:', e);
    }

    this.setupEventListeners();
    this.startSessionPoller();
  }

  setupEventListeners() {
    // Native window dragging on macOS
    document.addEventListener('mousedown', (e) => {
      const header = e.target.closest('.window-header, [data-tauri-drag-region]');
      if (!header) return;
      if (e.target.closest('button, input, select, .tab-item, a')) return;
      if (e.buttons === 1) {
        if (window.__TAURI__ && window.__TAURI__.core) {
          window.__TAURI__.core.invoke('start_window_drag');
        }
      }
    });

    // Double-click titlebar to zoom/maximize
    document.addEventListener('dblclick', (e) => {
      const header = e.target.closest('.window-header, [data-tauri-drag-region]');
      if (!header) return;
      if (e.target.closest('button, input, select, .tab-item, a')) return;
      if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('toggle_maximize');
      }
    });

    // New tab button
    this.newTabBtn.addEventListener('click', () => {
      this.selectTab('new');
    });

    // Fullscreen button in header
    this.fullscreenBtn.addEventListener('click', async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        await window.__TAURI__.core.invoke('toggle_fullscreen', { windowLabel: 'main' });
      }
    });

    // Form resolution buttons
    const resBtns = document.querySelectorAll('.res-btn');
    resBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        resBtns.forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        document.getElementById('input-width').value = btn.dataset.w;
        document.getElementById('input-height').value = btn.dataset.h;
      });
    });

    // Connect form submission
    this.connectForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleConnect();
    });

    // HUD Actions
    this.hudDetachBtn.addEventListener('click', () => {
      if (typeof this.activeTabId === 'number') {
        this.detachTab(this.activeTabId);
      }
    });

    this.hudFullscreenBtn.addEventListener('click', async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        await window.__TAURI__.core.invoke('toggle_fullscreen', { windowLabel: 'main' });
      }
    });

    this.hudDisconnectBtn.addEventListener('click', () => {
      if (typeof this.activeTabId === 'number') {
        this.closeSession(this.activeTabId);
      }
    });
  }

  async handleConnect() {
    const host = document.getElementById('input-host').value.trim();
    const port = parseInt(document.getElementById('input-port').value, 10) || 3389;
    const username = document.getElementById('input-username').value.trim();
    const password = document.getElementById('input-password').value;
    const domain = document.getElementById('input-domain').value.trim() || null;
    const width = parseInt(document.getElementById('input-width').value, 10) || 1920;
    const height = parseInt(document.getElementById('input-height').value, 10) || 1080;
    const enableNla = document.getElementById('input-nla').checked;

    if (!host || !username) {
      alert('Host and Username are required.');
      return;
    }

    try {
      if (window.__TAURI__ && window.__TAURI__.core) {
        const session = await window.__TAURI__.core.invoke('connect_session', {
          options: {
            host,
            port,
            username,
            password,
            domain,
            width,
            height,
            enable_nla: enableNla,
          },
        });

        this.selectTab(session.id);
      }
    } catch (err) {
      alert(`Connection failed: ${err}`);
    }
  }

  startSessionPoller() {
    setInterval(async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try {
          const list = await window.__TAURI__.core.invoke('list_sessions');
          this.sessions = list;
          this.renderTabs();
        } catch (e) {
          // ignore
        }
      }
    }, 1000);
  }

  renderTabs() {
    // Keep existing tabs or update them
    this.tabStrip.innerHTML = '';

    // Only render tabs that are not detached
    const attachedSessions = this.sessions.filter((s) => !s.is_detached);

    attachedSessions.forEach((s) => {
      const tabEl = document.createElement('div');
      tabEl.className = `tab-item ${this.activeTabId === s.id ? 'active' : ''}`;
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('data-tauri-drag-region', 'false');

      let dotClass = 'disconnected';
      if (s.status.includes('Connected')) dotClass = 'connected';
      else if (s.status.includes('Connecting')) dotClass = 'connecting';
      else if (s.status.includes('Error')) dotClass = 'error';

      tabEl.innerHTML = `
        <span class="status-dot ${dotClass}"></span>
        <span>${s.username} @ ${s.host}</span>
        <button class="tab-btn detach-btn" title="Detach into separate window">⧉</button>
        <button class="tab-btn close-btn" title="Close connection">✕</button>
      `;

      tabEl.addEventListener('click', (e) => {
        if (!e.target.classList.contains('tab-btn')) {
          this.selectTab(s.id);
        }
      });

      tabEl.querySelector('.detach-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.detachTab(s.id);
      });

      tabEl.querySelector('.close-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeSession(s.id);
      });

      this.tabStrip.appendChild(tabEl);
    });

    // If active session was detached or closed, fall back to new tab
    if (typeof this.activeTabId === 'number') {
      const exists = attachedSessions.some((s) => s.id === this.activeTabId);
      if (!exists) {
        this.selectTab(attachedSessions.length > 0 ? attachedSessions[0].id : 'new');
      }
    }
  }

  selectTab(tabId) {
    this.activeTabId = tabId;

    if (tabId === 'new') {
      this.dashboardView.style.display = 'flex';
      this.canvasView.style.display = 'none';
      if (this.activeStream) {
        this.activeStream.destroy();
        this.activeStream = null;
      }
    } else {
      this.dashboardView.style.display = 'none';
      this.canvasView.style.display = 'flex';

      const s = this.sessions.find((sess) => sess.id === tabId);
      if (s) {
        this.hudSessionName.textContent = `${s.username} @ ${s.host}:${s.port}`;
      }

      // Re-initialize stream for this session
      if (this.activeStream) {
        this.activeStream.destroy();
      }

      this.activeStream = new RdpCanvasStream(
        this.canvas,
        tabId,
        this.streamPort,
        (fps) => {
          this.fpsBadge.textContent = `${fps} FPS`;
        }
      );
    }

    this.renderTabs();
  }

  async detachTab(sessionId) {
    if (window.__TAURI__ && window.__TAURI__.core) {
      await window.__TAURI__.core.invoke('detach_tab', { sessionId });
      // Switch to new tab or next attached tab
      this.selectTab('new');
    }
  }

  async closeSession(sessionId) {
    if (window.__TAURI__ && window.__TAURI__.core) {
      await window.__TAURI__.core.invoke('disconnect_session', { sessionId });
      this.selectTab('new');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new ViewPortApp();
});
