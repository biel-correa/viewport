/**
 * Per-connection keyboard mapping form controller.
 */

import { ALL_KEY_CODES, DEFAULT_KEY_MAP } from './scancodes.js';

export function createKeymapController(dom) {
  function addCustomKeyRuleRow(fromCode = 'CapsLock', toCode = 'ControlLeft') {
    if (!dom.customKeymapList) return;
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
    dom.customKeymapList.appendChild(row);
  }

  function readKeyMapFromForm() {
    const custom = [];
    if (dom.customKeymapList) {
      dom.customKeymapList.querySelectorAll('.keymap-rule-row').forEach((row) => {
        const from = row.querySelector('.keymap-from')?.value;
        const to = row.querySelector('.keymap-to')?.value;
        if (from && to) custom.push({ from, to });
      });
    }
    return {
      mode: dom.keyMapModeSelect ? dom.keyMapModeSelect.value : DEFAULT_KEY_MAP.mode,
      meta: dom.keyMapMetaSelect ? dom.keyMapMetaSelect.value : DEFAULT_KEY_MAP.meta,
      alt: dom.keyMapAltSelect ? dom.keyMapAltSelect.value : DEFAULT_KEY_MAP.alt,
      ctrl: dom.keyMapCtrlSelect ? dom.keyMapCtrlSelect.value : DEFAULT_KEY_MAP.ctrl,
      caps: dom.keyMapCapsSelect ? dom.keyMapCapsSelect.value : DEFAULT_KEY_MAP.caps,
      custom
    };
  }

  function applyKeyMapToForm(keyMap) {
    const km = { ...DEFAULT_KEY_MAP, ...(keyMap || {}) };
    if (dom.keyMapModeSelect) dom.keyMapModeSelect.value = km.mode || DEFAULT_KEY_MAP.mode;
    if (dom.keyMapMetaSelect) dom.keyMapMetaSelect.value = km.meta || DEFAULT_KEY_MAP.meta;
    if (dom.keyMapAltSelect) dom.keyMapAltSelect.value = km.alt || DEFAULT_KEY_MAP.alt;
    if (dom.keyMapCtrlSelect) dom.keyMapCtrlSelect.value = km.ctrl || DEFAULT_KEY_MAP.ctrl;
    if (dom.keyMapCapsSelect) dom.keyMapCapsSelect.value = km.caps || DEFAULT_KEY_MAP.caps;
    if (dom.customKeymapList) {
      dom.customKeymapList.innerHTML = '';
      if (Array.isArray(km.custom)) {
        km.custom.forEach((rule) => {
          if (rule?.from && rule?.to) addCustomKeyRuleRow(rule.from, rule.to);
        });
      }
    }
  }

  if (dom.btnKeymapMacWin) {
    dom.btnKeymapMacWin.addEventListener('click', () => {
      applyKeyMapToForm({
        mode: dom.keyMapModeSelect ? dom.keyMapModeSelect.value : DEFAULT_KEY_MAP.mode,
        meta: 'Control',
        alt: 'Alt',
        ctrl: 'Meta',
        caps: dom.keyMapCapsSelect ? dom.keyMapCapsSelect.value : DEFAULT_KEY_MAP.caps,
        custom: readKeyMapFromForm().custom
      });
    });
  }

  if (dom.btnKeymapReset) {
    dom.btnKeymapReset.addEventListener('click', () => applyKeyMapToForm(DEFAULT_KEY_MAP));
  }

  if (dom.btnAddKeyrule) {
    dom.btnAddKeyrule.addEventListener('click', () => addCustomKeyRuleRow());
  }

  return {
    addCustomKeyRuleRow,
    readKeyMapFromForm,
    applyKeyMapToForm
  };
}
