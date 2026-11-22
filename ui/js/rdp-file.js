/**
 * Microsoft .rdp file decoder & parser (UTF-16 LE/BE and UTF-8 compatible).
 */

import { DEFAULT_KEY_MAP } from './scancodes.js';
import { parseCredentials, parseHostAndPort } from './utils.js';

const PRESET_RESOLUTIONS = new Set([
  '1920x1080',
  '2560x1440',
  '2880x1800',
  '3840x2160',
  '1280x720'
]);

/**
 * Decodes raw .rdp bytes into a UTF-8 string, handling UTF-16 LE/BE BOMs used by Windows mstsc.exe.
 */
export function decodeRdpBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let text;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = new TextDecoder('utf-8').decode(bytes.subarray(3));
  } else {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  return text.replace(/\0/g, '');
}

function parseRdpInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = String(value).trim();
  const parsed = /^0x/i.test(trimmed) ? Number.parseInt(trimmed, 16) : Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRdpAddress(rawAddress, serverPortOverride = null) {
  const trimmed = String(rawAddress || '').trim();
  if (!trimmed) return { host: '', port: 3389 };

  let host = trimmed;
  let port = null;

  // Bracketed IPv6 e.g. [::1]:3390
  const ipv6Match = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Match) {
    host = ipv6Match[1].trim();
    if (ipv6Match[2]) port = Number(ipv6Match[2]);
  } else if ((trimmed.match(/:/g) || []).length === 1) {
    const parsed = parseHostAndPort(trimmed);
    host = parsed.host;
    port = parsed.port;
  }

  if (!port || port <= 0 || port > 65535) {
    port =
      serverPortOverride && serverPortOverride > 0 && serverPortOverride <= 65535
        ? serverPortOverride
        : 3389;
  }

  return { host, port };
}

function deriveNicknameFromFilename(filename, host) {
  const base = String(filename || '')
    .trim()
    .replace(/\.rdp$/i, '')
    .trim();
  if (!base || base.toLowerCase() === String(host || '').toLowerCase()) {
    return '';
  }
  return base;
}

/**
 * Parses standard Microsoft `.rdp` key:type:value text into a ViewPort saved-machine shape.
 */
export function parseRdpContent(text, filename = '') {
  const entries = {};
  const lines = String(text || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    // Standard format: "<property name>:<type s|i|b>:<value>"
    const match = line.match(/^([^:]+):([sib]):(.*)$/i);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const type = match[2].toLowerCase();
    const value = match[3].trim();
    entries[key] = { type, value };
  }

  const rawAddress = entries['full address']?.value || entries['alternate full address']?.value || '';
  const serverPort = parseRdpInt(entries['server port']?.value);
  const { host, port } = parseRdpAddress(rawAddress, serverPort);

  if (!host) {
    throw new Error('Could not find a valid "full address" entry in this .rdp file.');
  }

  const rawUser = entries['username']?.value || '';
  const rawDomain = entries['domain']?.value || '';
  const parsedCreds = parseCredentials(rawUser, '');
  const domain =
    parsedCreds.domain ||
    (rawDomain && !parsedCreds.username.includes('@') ? rawDomain : null);
  const user = parsedCreds.username;

  const friendlyFromFile = entries['friendlyname']?.value || entries['displayname']?.value || '';
  const nickname = friendlyFromFile || deriveNicknameFromFilename(filename, host);

  const desktopW = parseRdpInt(entries['desktopwidth']?.value);
  const desktopH = parseRdpInt(entries['desktopheight']?.value);
  const smartSizing = parseRdpInt(entries['smart sizing']?.value);
  const dynamicResInt = parseRdpInt(entries['dynamic resolution']?.value);
  const screenModeId = parseRdpInt(entries['screen mode id']?.value);

  let resolution = 'fit';
  if (desktopW && desktopH && desktopW >= 640 && desktopH >= 480) {
    const candidate = `${desktopW}x${desktopH}`;
    if (screenModeId === 2 && (dynamicResInt === 1 || smartSizing === 1)) {
      resolution = 'fit';
    } else if (PRESET_RESOLUTIONS.has(candidate)) {
      resolution = candidate;
    } else {
      resolution = candidate;
    }
  }

  const bpp = parseRdpInt(entries['session bpp']?.value);
  const colorDepth = bpp === 16 || bpp === 24 || bpp === 32 ? String(bpp) : '32';

  const audioMode = parseRdpInt(entries['audiomode']?.value);
  let audioOut = 'local';
  if (audioMode === 1) audioOut = 'remote';
  else if (audioMode === 2) audioOut = 'mute';

  const enableNla = parseRdpInt(entries['enablecredsspsupport']?.value) !== 0;
  const reconnect = parseRdpInt(entries['autoreconnection enabled']?.value) !== 0;
  const swapMouse = parseRdpInt(entries['swapmousebuttons']?.value) === 1;
  const dynamicRes = dynamicResInt !== null ? dynamicResInt !== 0 : true;
  const enableClipboard = parseRdpInt(entries['redirectclipboard']?.value) !== 0;
  const enableMic =
    entries['audiocapturemode'] !== undefined
      ? parseRdpInt(entries['audiocapturemode']?.value) === 1
      : true;
  const enableCamera =
    entries['camerastoredirect'] !== undefined
      ? entries['camerastoredirect'].value.length > 0 && entries['camerastoredirect'].value !== '0'
      : true;

  const hasEncryptedPassword = Boolean(entries['password 51']?.value);
  const warnings = [];
  if (hasEncryptedPassword) {
    warnings.push('Encrypted Windows password in .rdp cannot be decrypted — please enter password manually.');
  }
  if (entries['gatewayhostname']?.value) {
    warnings.push(`RD Gateway (${entries['gatewayhostname'].value}) is not yet supported.`);
  }

  const machine = {
    id: `srv-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    nickname,
    name: nickname || host,
    ip: host,
    port,
    user,
    domain,
    password: '',
    enableNla,
    enableMic,
    enableCamera,
    enableClipboard,
    audioOut,
    swapMouse,
    dynamicRes,
    retina: true,
    reconnect,
    colorDepth,
    keyMap: { ...DEFAULT_KEY_MAP, custom: [] },
    macAddress: '',
    wolBroadcast: '',
    wakeOnConnect: false,
    group: 'Saved PCs',
    isServer: false,
    lastConnected: 'Imported',
    resolution
  };

  return {
    raw: entries,
    machine,
    warnings,
    hasEncryptedPassword
  };
}
