pub mod scancodes;

pub use scancodes::Scancode;

use ironrdp_pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::input::mouse::{MousePdu, PointerFlags};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// Converts a hardware Scancode and press/release state into an RDP `FastPathInputEvent`.
pub fn scancode_to_event(scancode: Scancode, pressed: bool) -> FastPathInputEvent {
    let mut flags = KeyboardFlags::empty();
    if !pressed {
        flags |= KeyboardFlags::RELEASE;
    }
    if scancode.1 {
        flags |= KeyboardFlags::EXTENDED;
    }
    FastPathInputEvent::KeyboardEvent(flags, scancode.0)
}

/// Converts a UTF-16 code unit and press/release state into an RDP Unicode `FastPathInputEvent`.
pub fn unicode_to_event(code_unit: u16, pressed: bool) -> FastPathInputEvent {
    let mut flags = KeyboardFlags::empty();
    if !pressed {
        flags |= KeyboardFlags::RELEASE;
    }
    FastPathInputEvent::UnicodeKeyboardEvent(flags, code_unit)
}

/// Creates a mouse move `FastPathInputEvent` at the specified remote coordinates.
pub fn mouse_move_event(x: u16, y: u16) -> FastPathInputEvent {
    FastPathInputEvent::MouseEvent(MousePdu {
        flags: PointerFlags::MOVE,
        number_of_wheel_rotation_units: 0,
        x_position: x,
        y_position: y,
    })
}

/// Creates a mouse button press or release `FastPathInputEvent`.
pub fn mouse_button_event(
    button: MouseButton,
    pressed: bool,
    x: u16,
    y: u16,
) -> FastPathInputEvent {
    let mut flags = match button {
        MouseButton::Left => PointerFlags::LEFT_BUTTON,
        MouseButton::Right => PointerFlags::RIGHT_BUTTON,
        MouseButton::Middle => PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
    };

    if pressed {
        flags |= PointerFlags::DOWN;
    }

    FastPathInputEvent::MouseEvent(MousePdu {
        flags,
        number_of_wheel_rotation_units: 0,
        x_position: x,
        y_position: y,
    })
}

/// Creates a vertical wheel scroll `FastPathInputEvent`.
pub fn mouse_wheel_event(x: u16, y: u16, units: i16) -> FastPathInputEvent {
    let clamped_units = units.clamp(-256, 255);
    FastPathInputEvent::MouseEvent(MousePdu {
        flags: PointerFlags::VERTICAL_WHEEL,
        number_of_wheel_rotation_units: clamped_units,
        x_position: x,
        y_position: y,
    })
}

/// Calculates the remote desktop (x, y) coordinates given the local click position
/// within an UI rectangle, maintaining proper aspect ratio and scaling.
pub fn local_to_remote_coords(
    local_pos: (f32, f32),
    rect_min: (f32, f32),
    rect_size: (f32, f32),
    remote_size: (u16, u16),
) -> Option<(u16, u16)> {
    let rel_x = local_pos.0 - rect_min.0;
    let rel_y = local_pos.1 - rect_min.1;

    if rel_x < 0.0 || rel_y < 0.0 || rel_x > rect_size.0 || rel_y > rect_size.1 {
        return None;
    }

    let scale_x = remote_size.0 as f32 / rect_size.0;
    let scale_y = remote_size.1 as f32 / rect_size.1;

    let target_x = (rel_x * scale_x).round() as u16;
    let target_y = (rel_y * scale_y).round() as u16;

    let clamped_x = target_x.min(remote_size.0.saturating_sub(1));
    let clamped_y = target_y.min(remote_size.1.saturating_sub(1));

    Some((clamped_x, clamped_y))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scancode_events() {
        let press = scancode_to_event(Scancode::KEY_A, true);
        match press {
            FastPathInputEvent::KeyboardEvent(flags, code) => {
                assert_eq!(code, 0x1E);
                assert!(!flags.contains(KeyboardFlags::RELEASE));
                assert!(!flags.contains(KeyboardFlags::EXTENDED));
            }
            _ => panic!("Expected keyboard event"),
        }

        let release_ext = scancode_to_event(Scancode::UP_ARROW, false);
        match release_ext {
            FastPathInputEvent::KeyboardEvent(flags, code) => {
                assert_eq!(code, 0x48);
                assert!(flags.contains(KeyboardFlags::RELEASE));
                assert!(flags.contains(KeyboardFlags::EXTENDED));
            }
            _ => panic!("Expected extended keyboard release event"),
        }
    }

    #[test]
    fn test_unicode_events() {
        let press = unicode_to_event('ç' as u16, true);
        match press {
            FastPathInputEvent::UnicodeKeyboardEvent(flags, code) => {
                assert_eq!(code, 0x00E7);
                assert!(!flags.contains(KeyboardFlags::RELEASE));
            }
            _ => panic!("Expected unicode keyboard press event"),
        }

        let release = unicode_to_event('á' as u16, false);
        match release {
            FastPathInputEvent::UnicodeKeyboardEvent(flags, code) => {
                assert_eq!(code, 0x00E1);
                assert!(flags.contains(KeyboardFlags::RELEASE));
            }
            _ => panic!("Expected unicode keyboard release event"),
        }
    }

    #[test]
    fn test_local_to_remote_coords_mapping() {
        let local_pos = (500.0, 300.0);
        let rect_min = (100.0, 100.0);
        let rect_size = (800.0, 400.0);
        let remote_size = (1920, 1080);

        let mapped = local_to_remote_coords(local_pos, rect_min, rect_size, remote_size);
        assert!(mapped.is_some());
        let (rx, ry) = mapped.unwrap();
        // rel_x = 400/800 = 0.5 -> 1920 * 0.5 = 960
        // rel_y = 200/400 = 0.5 -> 1080 * 0.5 = 540
        assert_eq!(rx, 960);
        assert_eq!(ry, 540);

        // Outside rectangle bounds returns None
        assert!(local_to_remote_coords((50.0, 50.0), rect_min, rect_size, remote_size).is_none());
    }

    #[test]
    fn test_mouse_events() {
        let m_down = mouse_button_event(MouseButton::Left, true, 100, 200);
        match m_down {
            FastPathInputEvent::MouseEvent(pdu) => {
                assert!(pdu.flags.contains(PointerFlags::LEFT_BUTTON));
                assert!(pdu.flags.contains(PointerFlags::DOWN));
                assert_eq!(pdu.x_position, 100);
                assert_eq!(pdu.y_position, 200);
            }
            _ => panic!("Expected mouse event"),
        }

        let m_wheel = mouse_wheel_event(100, 200, 120);
        match m_wheel {
            FastPathInputEvent::MouseEvent(pdu) => {
                assert!(pdu.flags.contains(PointerFlags::VERTICAL_WHEEL));
                assert_eq!(pdu.number_of_wheel_rotation_units, 120);
            }
            _ => panic!("Expected mouse wheel event"),
        }
    }
}
