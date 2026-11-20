/**
 * Centralized DOM element registry for the main ViewPort window.
 */

export function getDomRefs() {
  return {
    appWindow: document.getElementById('app'),
    mainChrome: document.getElementById('main-chrome'),
    detachedChrome: document.getElementById('detached-chrome'),
    tabStrip: document.getElementById('tab-strip'),
    telemetryBadge: document.getElementById('telemetry-badge'),
    telemetryRes: document.getElementById('telemetry-res'),
    telemetryFps: document.getElementById('telemetry-fps'),
    telemetryPing: document.getElementById('telemetry-ping'),
    detachedTelemetryLabel: document.getElementById('detached-telemetry-label'),
    detachedSessionLabel: document.getElementById('detached-session-label'),

    dashboardView: document.getElementById('dashboard-view'),
    sessionView: document.getElementById('session-view'),
    savedGrid: document.getElementById('saved-grid'),
    savedCount: document.getElementById('saved-count'),
    searchInput: document.getElementById('search-hosts'),

    // Form Elements
    addPcForm: document.getElementById('add-pc-form'),
    pcNameInput: document.getElementById('pc-name'),
    customUserInput: document.getElementById('custom-user'),
    customPassInput: document.getElementById('custom-pass'),
    pcFriendlyInput: document.getElementById('pc-friendly'),
    pcGroupSelect: document.getElementById('pc-group'),
    pcGatewaySelect: document.getElementById('pc-gateway'),
    chkBypassGw: document.getElementById('chk-bypass-gw'),
    lblBypassGw: document.getElementById('lbl-bypass-gw'),
    chkNla: document.getElementById('chk-nla'),
    chkReconnect: document.getElementById('chk-reconnect'),
    chkSwapMouse: document.getElementById('chk-swap-mouse'),
    chkDynamicRes: document.getElementById('chk-dynamic-res'),
    chkRetina: document.getElementById('chk-retina'),
    chkMic: document.getElementById('chk-mic'),
    chkCamera: document.getElementById('chk-camera'),
    chkClipboard: document.getElementById('chk-clipboard'),
    pcAudioOut: document.getElementById('pc-audio-out'),
    pcResolutionSelect: document.getElementById('pc-resolution'),
    pcColorDepthSelect: document.getElementById('pc-color-depth'),
    pcMacInput: document.getElementById('pc-mac'),
    pcWolBroadcastInput: document.getElementById('pc-wol-broadcast'),
    chkWolConnect: document.getElementById('chk-wol-connect'),
    btnDetectMac: document.getElementById('btn-detect-mac'),
    formCardTitle: document.getElementById('form-card-title'),
    btnSaveOnly: document.getElementById('btn-save-only'),
    btnResetForm: document.getElementById('btn-reset-form'),
    workspaceEl: document.querySelector('.workspace'),

    btnToggleAdvanced: document.getElementById('btn-toggle-advanced'),
    advancedContainer: document.getElementById('advanced-container'),
    segmentedTabs: document.querySelectorAll('.seg-tab'),
    tabPanes: {
      general: document.getElementById('tab-pane-general'),
      display: document.getElementById('tab-pane-display'),
      devices: document.getElementById('tab-pane-devices'),
      keyboard: document.getElementById('tab-pane-keyboard'),
      folders: document.getElementById('tab-pane-folders')
    },

    // Keyboard Mapping Controls
    keyMapMetaSelect: document.getElementById('key-map-meta'),
    keyMapAltSelect: document.getElementById('key-map-alt'),
    keyMapCtrlSelect: document.getElementById('key-map-ctrl'),
    keyMapCapsSelect: document.getElementById('key-map-caps'),
    customKeymapList: document.getElementById('custom-keymap-list'),
    btnKeymapMacWin: document.getElementById('btn-keymap-mac-win'),
    btnKeymapReset: document.getElementById('btn-keymap-reset'),
    btnAddKeyrule: document.getElementById('btn-add-keyrule'),

    // Session Canvas & Overlays
    rdpCanvas: document.getElementById('rdp-canvas'),
    tabContextMenu: document.getElementById('tab-context-menu'),
    ctxTabTitle: document.getElementById('ctx-tab-title'),
    ctxTabQuality: document.getElementById('ctx-tab-quality'),
    ctxCadBtn: document.getElementById('ctx-cad-btn'),
    ctxDetachBtn: document.getElementById('ctx-detach-btn'),
    ctxFullscreenBtn: document.getElementById('ctx-fullscreen-btn'),
    ctxDisconnectBtn: document.getElementById('ctx-disconnect-btn'),

    connectingOverlay: document.getElementById('connecting-overlay'),
    connectingSubtext: document.getElementById('connecting-subtext'),
    errorModal: document.getElementById('error-modal'),
    errorDescription: document.getElementById('error-description'),
    errorHostLabel: document.getElementById('error-host-label'),
    errorReconnectLabel: document.getElementById('error-reconnect-label'),
    btnErrorWake: document.getElementById('btn-error-wake'),
    btnErrorRetry: document.getElementById('btn-error-retry'),
    btnErrorEdit: document.getElementById('btn-error-edit'),

    // Top Bar / Window Controls
    btnDockBack: document.getElementById('btn-dock-back'),
    btnDetachedClose: document.getElementById('btn-detached-close'),
    tlFullscreenBtn: document.getElementById('tl-fullscreen-btn'),
    btnDetachedFullscreen: document.getElementById('btn-detached-fullscreen')
  };
}
