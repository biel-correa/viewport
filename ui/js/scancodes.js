/**
 * Maps standard Web KeyboardEvent.code strings to Windows PS/2 Scancodes (Set 1).
 * Returns { scancode: number, extended: boolean } or null.
 */
const SCANCODE_MAP = {
    // Top Row / Control
    Escape: { scancode: 0x01, extended: false },
    Digit1: { scancode: 0x02, extended: false },
    Digit2: { scancode: 0x03, extended: false },
    Digit3: { scancode: 0x04, extended: false },
    Digit4: { scancode: 0x05, extended: false },
    Digit5: { scancode: 0x06, extended: false },
    Digit6: { scancode: 0x07, extended: false },
    Digit7: { scancode: 0x08, extended: false },
    Digit8: { scancode: 0x09, extended: false },
    Digit9: { scancode: 0x0A, extended: false },
    Digit0: { scancode: 0x0B, extended: false },
    Minus: { scancode: 0x0C, extended: false },
    Equal: { scancode: 0x0D, extended: false },
    Backspace: { scancode: 0x0E, extended: false },
    Tab: { scancode: 0x0F, extended: false },

    // Letters Row 1
    KeyQ: { scancode: 0x10, extended: false },
    KeyW: { scancode: 0x11, extended: false },
    KeyE: { scancode: 0x12, extended: false },
    KeyR: { scancode: 0x13, extended: false },
    KeyT: { scancode: 0x14, extended: false },
    KeyY: { scancode: 0x15, extended: false },
    KeyU: { scancode: 0x16, extended: false },
    KeyI: { scancode: 0x17, extended: false },
    KeyO: { scancode: 0x18, extended: false },
    KeyP: { scancode: 0x19, extended: false },
    BracketLeft: { scancode: 0x1A, extended: false },
    BracketRight: { scancode: 0x1B, extended: false },
    Enter: { scancode: 0x1C, extended: false },

    // Letters Row 2
    ControlLeft: { scancode: 0x1D, extended: false },
    KeyA: { scancode: 0x1E, extended: false },
    KeyS: { scancode: 0x1F, extended: false },
    KeyD: { scancode: 0x20, extended: false },
    KeyF: { scancode: 0x21, extended: false },
    KeyG: { scancode: 0x22, extended: false },
    KeyH: { scancode: 0x23, extended: false },
    KeyJ: { scancode: 0x24, extended: false },
    KeyK: { scancode: 0x25, extended: false },
    KeyL: { scancode: 0x26, extended: false },
    Semicolon: { scancode: 0x27, extended: false },
    Quote: { scancode: 0x28, extended: false },
    Backquote: { scancode: 0x29, extended: false },

    // Letters Row 3
    ShiftLeft: { scancode: 0x2A, extended: false },
    Backslash: { scancode: 0x2B, extended: false },
    KeyZ: { scancode: 0x2C, extended: false },
    KeyX: { scancode: 0x2D, extended: false },
    KeyC: { scancode: 0x2E, extended: false },
    KeyV: { scancode: 0x2F, extended: false },
    KeyB: { scancode: 0x30, extended: false },
    KeyN: { scancode: 0x31, extended: false },
    KeyM: { scancode: 0x32, extended: false },
    Comma: { scancode: 0x33, extended: false },
    Period: { scancode: 0x34, extended: false },
    Slash: { scancode: 0x35, extended: false },
    ShiftRight: { scancode: 0x36, extended: false },
    AltLeft: { scancode: 0x38, extended: false },
    Space: { scancode: 0x39, extended: false },
    CapsLock: { scancode: 0x3A, extended: false },

    // Function Keys
    F1: { scancode: 0x3B, extended: false },
    F2: { scancode: 0x3C, extended: false },
    F3: { scancode: 0x3D, extended: false },
    F4: { scancode: 0x3E, extended: false },
    F5: { scancode: 0x3F, extended: false },
    F6: { scancode: 0x40, extended: false },
    F7: { scancode: 0x41, extended: false },
    F8: { scancode: 0x42, extended: false },
    F9: { scancode: 0x43, extended: false },
    F10: { scancode: 0x44, extended: false },
    F11: { scancode: 0x57, extended: false },
    F12: { scancode: 0x58, extended: false },

    // Extended Keys (E0-prefixed)
    ControlRight: { scancode: 0x1D, extended: true },
    AltRight: { scancode: 0x38, extended: true },
    Home: { scancode: 0x47, extended: true },
    ArrowUp: { scancode: 0x48, extended: true },
    PageUp: { scancode: 0x49, extended: true },
    ArrowLeft: { scancode: 0x4B, extended: true },
    ArrowRight: { scancode: 0x4D, extended: true },
    End: { scancode: 0x4F, extended: true },
    ArrowDown: { scancode: 0x50, extended: true },
    PageDown: { scancode: 0x51, extended: true },
    Insert: { scancode: 0x52, extended: true },
    Delete: { scancode: 0x53, extended: true },
    MetaLeft: { scancode: 0x5B, extended: true },
    MetaRight: { scancode: 0x5C, extended: true },
};

export const ALL_KEY_CODES = Object.keys(SCANCODE_MAP);

export const DEFAULT_KEY_MAP = {
  mode: 'unicode',
  meta: 'Meta',
  alt: 'Alt',
  ctrl: 'Control',
  caps: 'CapsLock',
  custom: []
};

export function hasCustomKeyRule(code, keyMap) {
  return Boolean(
    keyMap &&
      Array.isArray(keyMap.custom) &&
      keyMap.custom.some((r) => r && r.from === code)
  );
}

function resolveModifierSide(sourceCode, targetFamily) {
  if (!targetFamily || targetFamily === 'None') return null;
  if (targetFamily === 'Meta' || targetFamily === 'Control' || targetFamily === 'Alt' || targetFamily === 'Shift') {
    const side = sourceCode.endsWith('Right') ? 'Right' : 'Left';
    return `${targetFamily}${side}`;
  }
  return targetFamily;
}

export function remapKeyCode(code, keyMap) {
  if (!keyMap) return code;
  if (Array.isArray(keyMap.custom)) {
    const rule = keyMap.custom.find((r) => r && r.from === code);
    if (rule) {
      return rule.to === 'None' ? null : rule.to;
    }
  }
  if (code === 'MetaLeft' || code === 'MetaRight') {
    return resolveModifierSide(code, keyMap.meta || 'Meta');
  }
  if (code === 'AltLeft' || code === 'AltRight') {
    return resolveModifierSide(code, keyMap.alt || 'Alt');
  }
  if (code === 'ControlLeft' || code === 'ControlRight') {
    return resolveModifierSide(code, keyMap.ctrl || 'Control');
  }
  if (code === 'CapsLock') {
    return resolveModifierSide(code, keyMap.caps || 'CapsLock');
  }
  return code;
}

export function codeToScancode(code) {
  return SCANCODE_MAP[code] || null;
}

export function mappedCodeToScancode(code, keyMap) {
  const mappedCode = remapKeyCode(code, keyMap);
  return mappedCode ? codeToScancode(mappedCode) : null;
}
