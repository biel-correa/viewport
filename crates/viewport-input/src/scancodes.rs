/// Scancode representation: scancode byte and whether it is an extended key (0xE0 prefixed in PS/2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scancode(pub u8, pub bool);

impl Scancode {
    pub const ESCAPE: Self = Self(0x01, false);
    pub const KEY_1: Self = Self(0x02, false);
    pub const KEY_2: Self = Self(0x03, false);
    pub const KEY_3: Self = Self(0x04, false);
    pub const KEY_4: Self = Self(0x05, false);
    pub const KEY_5: Self = Self(0x06, false);
    pub const KEY_6: Self = Self(0x07, false);
    pub const KEY_7: Self = Self(0x08, false);
    pub const KEY_8: Self = Self(0x09, false);
    pub const KEY_9: Self = Self(0x0A, false);
    pub const KEY_0: Self = Self(0x0B, false);
    pub const MINUS: Self = Self(0x0C, false);
    pub const EQUALS: Self = Self(0x0D, false);
    pub const BACKSPACE: Self = Self(0x0E, false);
    pub const TAB: Self = Self(0x0F, false);

    pub const KEY_Q: Self = Self(0x10, false);
    pub const KEY_W: Self = Self(0x11, false);
    pub const KEY_E: Self = Self(0x12, false);
    pub const KEY_R: Self = Self(0x13, false);
    pub const KEY_T: Self = Self(0x14, false);
    pub const KEY_Y: Self = Self(0x15, false);
    pub const KEY_U: Self = Self(0x16, false);
    pub const KEY_I: Self = Self(0x17, false);
    pub const KEY_O: Self = Self(0x18, false);
    pub const KEY_P: Self = Self(0x19, false);
    pub const LEFT_BRACKET: Self = Self(0x1A, false);
    pub const RIGHT_BRACKET: Self = Self(0x1B, false);
    pub const ENTER: Self = Self(0x1C, false);

    pub const LEFT_CTRL: Self = Self(0x1D, false);
    pub const KEY_A: Self = Self(0x1E, false);
    pub const KEY_S: Self = Self(0x1F, false);
    pub const KEY_D: Self = Self(0x20, false);
    pub const KEY_F: Self = Self(0x21, false);
    pub const KEY_G: Self = Self(0x22, false);
    pub const KEY_H: Self = Self(0x23, false);
    pub const KEY_J: Self = Self(0x24, false);
    pub const KEY_K: Self = Self(0x25, false);
    pub const KEY_L: Self = Self(0x26, false);
    pub const SEMICOLON: Self = Self(0x27, false);
    pub const APOSTROPHE: Self = Self(0x28, false);
    pub const GRAVE: Self = Self(0x29, false);

    pub const LEFT_SHIFT: Self = Self(0x2A, false);
    pub const BACKSLASH: Self = Self(0x2B, false);
    pub const KEY_Z: Self = Self(0x2C, false);
    pub const KEY_X: Self = Self(0x2D, false);
    pub const KEY_C: Self = Self(0x2E, false);
    pub const KEY_V: Self = Self(0x2F, false);
    pub const KEY_B: Self = Self(0x30, false);
    pub const KEY_N: Self = Self(0x31, false);
    pub const KEY_M: Self = Self(0x32, false);
    pub const COMMA: Self = Self(0x33, false);
    pub const PERIOD: Self = Self(0x34, false);
    pub const SLASH: Self = Self(0x35, false);
    pub const RIGHT_SHIFT: Self = Self(0x36, false);
    pub const KP_MULTIPLY: Self = Self(0x37, false);
    pub const LEFT_ALT: Self = Self(0x38, false);
    pub const SPACE: Self = Self(0x39, false);
    pub const CAPS_LOCK: Self = Self(0x3A, false);

    pub const F1: Self = Self(0x3B, false);
    pub const F2: Self = Self(0x3C, false);
    pub const F3: Self = Self(0x3D, false);
    pub const F4: Self = Self(0x3E, false);
    pub const F5: Self = Self(0x3F, false);
    pub const F6: Self = Self(0x40, false);
    pub const F7: Self = Self(0x41, false);
    pub const F8: Self = Self(0x42, false);
    pub const F9: Self = Self(0x43, false);
    pub const F10: Self = Self(0x44, false);
    pub const NUM_LOCK: Self = Self(0x45, false);
    pub const SCROLL_LOCK: Self = Self(0x46, false);

    pub const F11: Self = Self(0x57, false);
    pub const F12: Self = Self(0x58, false);

    // Extended Keys (Set 1 E0 prefixed)
    pub const KP_ENTER: Self = Self(0x1C, true);
    pub const RIGHT_CTRL: Self = Self(0x1D, true);
    pub const KP_DIVIDE: Self = Self(0x35, true);
    pub const RIGHT_ALT: Self = Self(0x38, true);
    pub const HOME: Self = Self(0x47, true);
    pub const UP_ARROW: Self = Self(0x48, true);
    pub const PAGE_UP: Self = Self(0x49, true);
    pub const LEFT_ARROW: Self = Self(0x4B, true);
    pub const RIGHT_ARROW: Self = Self(0x4D, true);
    pub const END: Self = Self(0x4F, true);
    pub const DOWN_ARROW: Self = Self(0x50, true);
    pub const PAGE_DOWN: Self = Self(0x51, true);
    pub const INSERT: Self = Self(0x52, true);
    pub const DELETE: Self = Self(0x53, true);
    pub const LEFT_SUPER: Self = Self(0x5B, true);
    pub const RIGHT_SUPER: Self = Self(0x5C, true);
}
