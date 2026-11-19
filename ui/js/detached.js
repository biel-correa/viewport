import { RdpCanvasStream } from './canvas.js';

document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = parseInt(urlParams.get('id'), 10);

  if (!sessionId) {
    alert('Invalid session ID');
    return;
  }

  const canvas = document.getElementById('detached-canvas');
  const sessionName = document.getElementById('session-name');
  const dockBtn = document.getElementById('dock-btn');
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  const disconnectBtn = document.getElementById('disconnect-btn');

  let streamPort = 0;
  if (window.__TAURI__ && window.__TAURI__.core) {
    streamPort = await window.__TAURI__.core.invoke('get_stream_port');
  }

  sessionName.textContent = `Session #${sessionId}`;

  // Start canvas stream
  new RdpCanvasStream(canvas, sessionId, streamPort, (fps) => {
    // optional fps display
  });

  // Window Dragging & Maximize
  document.addEventListener('mousedown', (e) => {
    const header = e.target.closest('.detached-bar, [data-tauri-drag-region]');
    if (!header) return;
    if (e.target.closest('button, input, a')) return;
    if (e.buttons === 1) {
      if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('start_window_drag');
      }
    }
  });

  document.addEventListener('dblclick', (e) => {
    const header = e.target.closest('.detached-bar, [data-tauri-drag-region]');
    if (!header) return;
    if (e.target.closest('button, input, a')) return;
    if (window.__TAURI__ && window.__TAURI__.core) {
      window.__TAURI__.core.invoke('toggle_maximize');
    }
  });

  // Dock back to tabs
  dockBtn.addEventListener('click', async () => {
    if (window.__TAURI__ && window.__TAURI__.core) {
      await window.__TAURI__.core.invoke('dock_tab', { sessionId });
    }
  });

  // Fullscreen
  fullscreenBtn.addEventListener('click', async () => {
    if (window.__TAURI__ && window.__TAURI__.core) {
      await window.__TAURI__.core.invoke('toggle_fullscreen', {
        windowLabel: `detached-${sessionId}`,
      });
    }
  });

  // Disconnect
  disconnectBtn.addEventListener('click', async () => {
    if (window.__TAURI__ && window.__TAURI__.core) {
      await window.__TAURI__.core.invoke('disconnect_session', { sessionId });
      await window.__TAURI__.core.invoke('dock_tab', { sessionId });
    }
  });
});
