/**
 * Pure formatting, parsing, and resolution utilities.
 */

import { RdpCanvasStream } from './canvas.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseHostAndPort(rawHost) {
  const trimmed = String(rawHost || '').trim();
  if (trimmed.includes(':')) {
    const lastColon = trimmed.lastIndexOf(':');
    const host = trimmed.slice(0, lastColon).trim();
    const port = Number(trimmed.slice(lastColon + 1).trim());
    return { host, port: port > 0 && port <= 65535 ? port : 3389 };
  }
  return { host: trimmed, port: 3389 };
}

export function parseCredentials(rawUser, password = '') {
  const trimmed = String(rawUser || '').trim();
  let domain = null;
  let username = trimmed;

  if (trimmed.includes('\\')) {
    const parts = trimmed.split('\\');
    domain = parts[0] || null;
    username = parts.slice(1).join('\\') || '';
  }

  return { username, password, domain };
}

export function formatPing(pingMs) {
  if (pingMs === null || pingMs === undefined || pingMs < 0) return '-- ms';
  return pingMs === 0 ? '<1 ms' : `${pingMs} ms`;
}

export function getFreeWorkspaceResolution(workspaceEl) {
  const rawW = workspaceEl && workspaceEl.clientWidth > 200 ? workspaceEl.clientWidth : window.innerWidth;
  const rawH = workspaceEl && workspaceEl.clientHeight > 200 ? workspaceEl.clientHeight : window.innerHeight - 46;
  return RdpCanvasStream.normalizeResolution(rawW, rawH);
}

export function parseResolution(resStr, workspaceEl) {
  if (!resStr || resStr === 'fit') {
    return getFreeWorkspaceResolution(workspaceEl);
  }
  const [w, h] = resStr.split('x').map(Number);
  if (!w || !h) {
    return getFreeWorkspaceResolution(workspaceEl);
  }
  return RdpCanvasStream.normalizeResolution(w, h);
}
