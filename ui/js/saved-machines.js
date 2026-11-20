/**
 * Saved PCs card grid, search filter, and per-card actions (Wake, Edit, Delete, Connect).
 */

import { isTauri, invoke } from './tauri.js';
import { persistSavedMachines } from './state.js';
import { escapeHtml } from './utils.js';

export function createSavedMachinesController({
  state,
  dom,
  onEditMachine,
  onDeleteEditingMachine,
  onLaunchMachine
}) {
  function renderSavedMachines(filterText = dom.searchInput ? dom.searchInput.value : '') {
    const query = String(filterText || '').trim().toLowerCase();
    const filtered = state.savedMachines.filter(
      (m) =>
        (m.nickname || '').toLowerCase().includes(query) ||
        (m.name || '').toLowerCase().includes(query) ||
        (m.ip || '').toLowerCase().includes(query) ||
        (m.user || '').toLowerCase().includes(query) ||
        (m.group || '').toLowerCase().includes(query)
    );

    if (dom.savedCount) {
      dom.savedCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'machine' : 'machines'}`;
    }
    if (!dom.savedGrid) return;
    dom.savedGrid.innerHTML = '';

    if (filtered.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'host-card';
      emptyEl.style.textAlign = 'center';
      emptyEl.style.padding = '28px 18px';
      emptyEl.style.color = 'var(--text-muted)';
      emptyEl.innerHTML = `
        <p style="font-size: 13px;">No saved PCs yet. Enter a host & username on the left and click <strong>Save to PCs</strong> or <strong>Connect</strong>.</p>
      `;
      dom.savedGrid.appendChild(emptyEl);
      return;
    }

    filtered.forEach((machine) => {
      const cardTitle = machine.nickname || machine.name || machine.ip;
      const card = document.createElement('article');
      card.className = `host-card ${machine.id === state.editingMachineId ? 'editing' : ''}`;
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
        onEditMachine(machine, { focusField: 'nickname' });
      });

      card.querySelector('.btn-delete-saved').addEventListener('click', (e) => {
        e.stopPropagation();
        state.savedMachines = state.savedMachines.filter((m) => m.id !== machine.id);
        persistSavedMachines(state.savedMachines);
        if (state.editingMachineId === machine.id) {
          onDeleteEditingMachine();
        } else {
          renderSavedMachines();
        }
      });

      card.querySelector('.btn-launch-card').addEventListener('click', () => {
        const passToUse = machine.password || dom.customPassInput.value;
        if (!passToUse) {
          onEditMachine(machine, { focusField: 'password' });
          return;
        }

        machine.lastConnected = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        persistSavedMachines(state.savedMachines);
        renderSavedMachines();

        const cardNick = machine.nickname || (machine.name !== machine.ip ? machine.name : '');
        onLaunchMachine({
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

      dom.savedGrid.appendChild(card);
    });

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  if (dom.searchInput) {
    dom.searchInput.addEventListener('input', (e) => renderSavedMachines(e.target.value));
  }

  return {
    renderSavedMachines
  };
}
