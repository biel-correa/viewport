use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::process::Command;

/// Parses a MAC address in common formats (`AA:BB:CC:DD:EE:FF`, `AA-BB-...`, `AABB.CCDD.EEFF`, or `AABBCCDDEEFF`).
pub fn parse_mac_address(mac: &str) -> Result<[u8; 6], String> {
    let cleaned: String = mac
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | '.' | ' '))
        .collect();

    if cleaned.len() != 12 {
        return Err(format!(
            "Invalid MAC address '{}': expected 12 hex digits",
            mac.trim()
        ));
    }

    let mut bytes = [0u8; 6];
    for (idx, chunk) in cleaned.as_bytes().chunks_exact(2).enumerate() {
        let hex = std::str::from_utf8(chunk).map_err(|e| e.to_string())?;
        bytes[idx] = u8::from_str_radix(hex, 16)
            .map_err(|_| format!("Invalid hex byte '{}' in MAC address '{}'", hex, mac.trim()))?;
    }
    Ok(bytes)
}

pub fn format_mac(bytes: [u8; 6]) -> String {
    format!(
        "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]
    )
}

/// Builds a standard 102-byte Wake-on-LAN magic packet (`6x 0xFF` + `16x MAC`).
pub fn build_magic_packet(mac: [u8; 6]) -> [u8; 102] {
    let mut packet = [0xFFu8; 102];
    for chunk in packet[6..].chunks_exact_mut(6) {
        chunk.copy_from_slice(&mac);
    }
    packet
}

fn resolve_wol_ports(port: u16) -> Vec<u16> {
    if port == 0 || port == 9 {
        vec![9, 7]
    } else {
        vec![port]
    }
}

fn send_magic_via_socket(
    bind_addr: SocketAddr,
    targets: &[(IpAddr, u16)],
    packet: &[u8; 102],
    sent_to: &mut Vec<String>,
    last_err: &mut Option<String>,
) {
    let socket = match UdpSocket::bind(bind_addr) {
        Ok(s) => s,
        Err(e) => {
            *last_err = Some(format!("bind {}: {}", bind_addr, e));
            return;
        }
    };
    if let Err(e) = socket.set_broadcast(true) {
        *last_err = Some(format!("broadcast {}: {}", bind_addr, e));
        return;
    }
    let suffix = match bind_addr.ip() {
        IpAddr::V4(v4) if v4.is_unspecified() => String::new(),
        other => format!(" (via {})", other),
    };
    for &(ip, port) in targets {
        let addr = SocketAddr::new(ip, port);
        match socket.send_to(packet, addr) {
            Ok(_) => sent_to.push(format!("{}{}", addr, suffix)),
            Err(e) => *last_err = Some(format!("{}{}: {}", addr, suffix, e)),
        }
    }
}

/// Sends a Wake-on-LAN magic packet over UDP broadcast and returns the target socket addresses used.
pub fn send_wake_on_lan(
    mac: &str,
    broadcast_ip: Option<&str>,
    port: u16,
) -> Result<Vec<String>, String> {
    let mac_bytes = parse_mac_address(mac)?;
    let packet = build_magic_packet(mac_bytes);
    let ports = resolve_wol_ports(port);

    let mut targets: BTreeSet<IpAddr> = BTreeSet::new();
    let mut iface_bindings: Vec<(Ipv4Addr, Ipv4Addr)> = Vec::new();
    if let Some(custom) = broadcast_ip.map(str::trim).filter(|s| !s.is_empty()) {
        let ip: IpAddr = custom
            .parse()
            .map_err(|_| format!("Invalid broadcast IP address '{}'", custom))?;
        targets.insert(ip);
    } else {
        targets.insert(IpAddr::V4(Ipv4Addr::BROADCAST));
        for (local_ip, bcast_ip) in local_ipv4_broadcast_interfaces() {
            targets.insert(IpAddr::V4(bcast_ip));
            if let Some(local) = local_ip {
                iface_bindings.push((local, bcast_ip));
            }
        }
    }

    let mut sent_to = Vec::new();
    let mut last_err = None;

    let any_targets: Vec<(IpAddr, u16)> = targets
        .iter()
        .flat_map(|&ip| ports.iter().map(move |&p| (ip, p)))
        .collect();
    send_magic_via_socket(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        &any_targets,
        &packet,
        &mut sent_to,
        &mut last_err,
    );

    // Also send directly bound to each physical LAN interface IP so active VPN routes cannot hijack LAN broadcast.
    for (local_ip, bcast_ip) in iface_bindings {
        let per_iface_targets: Vec<(IpAddr, u16)> =
            ports.iter().map(|&p| (IpAddr::V4(bcast_ip), p)).collect();
        send_magic_via_socket(
            SocketAddr::new(IpAddr::V4(local_ip), 0),
            &per_iface_targets,
            &packet,
            &mut sent_to,
            &mut last_err,
        );
    }

    if sent_to.is_empty() {
        return Err(last_err.unwrap_or_else(|| "Failed to send Wake-on-LAN packet".to_string()));
    }

    Ok(sent_to)
}

/// Looks up the MAC address for a host from the local ARP cache (only works for hosts on the same LAN).
pub fn lookup_mac_for_host(host: &str) -> Result<Option<String>, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("Host cannot be empty".to_string());
    }

    let ipv4 = (trimmed, 3389u16)
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve '{}': {}", trimmed, e))?
        .find_map(|addr| match addr.ip() {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
        .ok_or_else(|| format!("No IPv4 address found for '{}'", trimmed))?;

    let output = Command::new("/usr/sbin/arp")
        .args(["-n", &ipv4.to_string()])
        .output()
        .map_err(|e| format!("Failed to query ARP table: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_arp_mac(&stdout))
}

fn parse_arp_mac(output: &str) -> Option<String> {
    for token in output.split_whitespace() {
        let candidate = token.trim_matches(|c| matches!(c, '(' | ')' | ',' | ';'));
        let parts: Vec<&str> = candidate.split(':').collect();
        if parts.len() == 6 && parts.iter().all(|p| !p.is_empty() && p.len() <= 2) {
            let mut bytes = [0u8; 6];
            let mut valid = true;
            for (idx, part) in parts.iter().enumerate() {
                match u8::from_str_radix(part, 16) {
                    Ok(val) => bytes[idx] = val,
                    Err(_) => {
                        valid = false;
                        break;
                    }
                }
            }
            if valid && bytes != [0xFF; 6] && bytes != [0u8; 6] {
                return Some(format_mac(bytes));
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn local_ipv4_broadcast_interfaces() -> Vec<(Option<Ipv4Addr>, Ipv4Addr)> {
    let mut interfaces = Vec::new();
    let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut ifap) } != 0 || ifap.is_null() {
        return interfaces;
    }

    let mut cur = ifap;
    while !cur.is_null() {
        let ifa = unsafe { &*cur };
        let flags = ifa.ifa_flags as i32;
        let has_broadcast = (flags & libc::IFF_BROADCAST) != 0
            && (flags & libc::IFF_UP) != 0
            && (flags & libc::IFF_LOOPBACK) == 0;
        if has_broadcast && !ifa.ifa_dstaddr.is_null() {
            let sa = unsafe { &*ifa.ifa_dstaddr };
            if i32::from(sa.sa_family) == libc::AF_INET {
                let sin = unsafe { &*(ifa.ifa_dstaddr as *const libc::sockaddr_in) };
                let bcast_ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                let local_ip = if !ifa.ifa_addr.is_null() {
                    let local_sa = unsafe { &*ifa.ifa_addr };
                    if i32::from(local_sa.sa_family) == libc::AF_INET {
                        let local_sin = unsafe { &*(ifa.ifa_addr as *const libc::sockaddr_in) };
                        let ip = Ipv4Addr::from(u32::from_be(local_sin.sin_addr.s_addr));
                        if ip.is_unspecified() {
                            None
                        } else {
                            Some(ip)
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                if !bcast_ip.is_unspecified() {
                    interfaces.push((local_ip, bcast_ip));
                }
            }
        }
        cur = ifa.ifa_next;
    }

    unsafe { libc::freeifaddrs(ifap) };
    interfaces
}

#[cfg(not(target_os = "macos"))]
fn local_ipv4_broadcast_interfaces() -> Vec<(Option<Ipv4Addr>, Ipv4Addr)> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_wol_ports_defaults_to_9_and_7() {
        assert_eq!(resolve_wol_ports(0), vec![9, 7]);
        assert_eq!(resolve_wol_ports(9), vec![9, 7]);
        assert_eq!(resolve_wol_ports(7), vec![7]);
    }

    #[test]
    fn test_parse_mac_variants() {
        let expected = [0xAA, 0xBB, 0xCC, 0x01, 0x23, 0xEF];
        assert_eq!(parse_mac_address("AA:BB:CC:01:23:EF").unwrap(), expected);
        assert_eq!(parse_mac_address("aa-bb-cc-01-23-ef").unwrap(), expected);
        assert_eq!(parse_mac_address("aabb.cc01.23ef").unwrap(), expected);
        assert_eq!(parse_mac_address("aabbcc0123ef").unwrap(), expected);
        assert!(parse_mac_address("invalid").is_err());
    }

    #[test]
    fn test_build_magic_packet() {
        let mac = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
        let pkt = build_magic_packet(mac);
        assert_eq!(&pkt[..6], &[0xFF; 6]);
        for chunk in pkt[6..].chunks_exact(6) {
            assert_eq!(chunk, &mac);
        }
    }

    #[test]
    fn test_parse_arp_mac_pads_single_hex_digits() {
        let sample = "? (192.168.29.103) at 4:92:26:a:1b:5 on en0 ifscope [ethernet]";
        assert_eq!(
            parse_arp_mac(sample).as_deref(),
            Some("04:92:26:0A:1B:05")
        );
        assert_eq!(parse_arp_mac("? (192.168.29.103) at (incomplete) on en0"), None);
    }
}
