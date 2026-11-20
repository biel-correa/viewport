/**
 * Software update checker: signed Tauri auto-update with GitHub Releases fallback.
 */

import { isTauri, invoke, listenTauriEvent } from './tauri.js';

export function initSoftwareUpdater() {
  if (!isTauri) return;

  const versionBadge = document.getElementById('app-version-badge');
  const btnCheckUpdate = document.getElementById('btn-check-update');
  const updateBanner = document.getElementById('update-banner');
  const updateBannerTitle = document.getElementById('update-banner-title');
  const updateBannerSub = document.getElementById('update-banner-sub');
  const updateProgressWrap = document.getElementById('update-progress-wrap');
  const updateProgressBar = document.getElementById('update-progress-bar');
  const btnUpdateAction = document.getElementById('btn-update-action');
  const btnUpdateNotes = document.getElementById('btn-update-notes');
  const btnUpdateDismiss = document.getElementById('btn-update-dismiss');

  let latestUpdateInfo = null;
  let isInstallingUpdate = false;

  invoke('get_app_version')
    .then((ver) => {
      if (ver && versionBadge) {
        versionBadge.textContent = `v${ver}`;
      }
    })
    .catch(() => {});

  listenTauriEvent('update-download-progress', (event) => {
    const payload = event.payload || {};
    if (!updateProgressWrap || !updateProgressBar) return;
    updateProgressWrap.classList.remove('hidden');
    if (typeof payload.percent === 'number') {
      updateProgressBar.style.width = `${payload.percent}%`;
      if (updateBannerSub) {
        updateBannerSub.textContent =
          payload.percent >= 100
            ? 'Installing update and restarting ViewPort...'
            : `Downloading update (${payload.percent}%)...`;
      }
    }
  });

  function renderUpdateBanner(info, fallbackReason = null) {
    latestUpdateInfo = info;
    if (!updateBanner || !info || !info.available) return;

    const useAutoUpdate = Boolean(info.canAutoUpdate) && !fallbackReason;
    updateBanner.classList.remove('hidden');
    updateBanner.classList.toggle('is-warning', !useAutoUpdate);

    if (updateBannerTitle) {
      updateBannerTitle.textContent = `ViewPort v${info.latestVersion} is available`;
    }
    if (updateBannerSub) {
      if (fallbackReason) {
        updateBannerSub.textContent = `Auto-update unavailable (${fallbackReason}). Download v${info.latestVersion} directly from GitHub.`;
      } else if (useAutoUpdate) {
        updateBannerSub.textContent = `You are on v${info.currentVersion}. Click Update & Restart to install automatically.`;
      } else {
        updateBannerSub.textContent = `You are on v${info.currentVersion}. Auto-update is unavailable for this package — download the latest installer from GitHub.`;
      }
    }

    if (btnUpdateAction) {
      const span = btnUpdateAction.querySelector('span');
      if (span) {
        span.textContent = useAutoUpdate ? 'Update & Restart' : 'Download Update';
      }
      btnUpdateAction.disabled = false;
    }

    if (updateProgressWrap) {
      updateProgressWrap.classList.add('hidden');
    }
    if (updateProgressBar) {
      updateProgressBar.style.width = '0%';
    }
  }

  async function runUpdateCheck(isManual = false) {
    const btnSpan = btnCheckUpdate ? btnCheckUpdate.querySelector('span') : null;
    if (isManual && btnCheckUpdate) {
      btnCheckUpdate.disabled = true;
      if (btnSpan) btnSpan.textContent = 'Checking...';
    }

    try {
      const info = await invoke('check_for_update');
      if (info && info.available) {
        renderUpdateBanner(info);
        if (isManual && btnSpan) btnSpan.textContent = `v${info.latestVersion} ready`;
      } else if (isManual && btnSpan) {
        btnSpan.textContent = 'Up to date';
      }
    } catch (err) {
      console.warn('Update check failed:', err);
      if (isManual && btnSpan) {
        btnSpan.textContent = 'Check failed';
      }
    } finally {
      if (isManual && btnCheckUpdate) {
        setTimeout(() => {
          if (btnSpan) btnSpan.textContent = 'Updates';
          btnCheckUpdate.disabled = false;
        }, 2200);
      }
    }
  }

  if (btnCheckUpdate) {
    btnCheckUpdate.addEventListener('click', () => runUpdateCheck(true));
  }

  if (btnUpdateDismiss && updateBanner) {
    btnUpdateDismiss.addEventListener('click', () => {
      if (isInstallingUpdate) return;
      updateBanner.classList.add('hidden');
    });
  }

  if (btnUpdateNotes) {
    btnUpdateNotes.addEventListener('click', () => {
      const url = latestUpdateInfo?.releaseUrl || latestUpdateInfo?.downloadUrl || '';
      invoke('open_download_url', { url }).catch((err) => {
        console.warn('Failed to open release notes:', err);
      });
    });
  }

  if (btnUpdateAction) {
    btnUpdateAction.addEventListener('click', async () => {
      if (!latestUpdateInfo || isInstallingUpdate) return;

      if (latestUpdateInfo.canAutoUpdate) {
        isInstallingUpdate = true;
        btnUpdateAction.disabled = true;
        const span = btnUpdateAction.querySelector('span');
        if (span) span.textContent = 'Updating...';
        if (updateBannerSub) updateBannerSub.textContent = 'Starting update download...';

        try {
          await invoke('install_update');
        } catch (err) {
          isInstallingUpdate = false;
          latestUpdateInfo = { ...latestUpdateInfo, canAutoUpdate: false };
          renderUpdateBanner(latestUpdateInfo, String(err));
        }
      } else {
        const url = latestUpdateInfo.downloadUrl || latestUpdateInfo.releaseUrl || '';
        invoke('open_download_url', { url }).catch((err) => {
          console.warn('Failed to open download link:', err);
        });
      }
    });
  }

  // Check quietly in the background shortly after launch
  setTimeout(() => runUpdateCheck(false), 2500);
}
