/**
 * Detects the installer technology from the file itself, using the rules in
 * backend/config/portal-presets.json (installer_detection). Reads only the head and
 * tail of the file, so it is instant even for multi-GB installers.
 */
import type { Defaults, InstallerType } from './types';

export interface DetectionRule {
  label: string;
  type: InstallerType;
  text?: string;
  magic_hex?: string;
  silentArgs?: string;
}
export interface Detected {
  label: string;
  type: InstallerType;
  silentArgs?: string;
}

const utf16 = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) b[i * 2] = s.charCodeAt(i) & 0xff;
  return b;
};
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

function indexOf(hay: Uint8Array, needle: Uint8Array) {
  if (!needle.length) return -1;
  const first = needle[0];
  outer: for (let i = hay.indexOf(first); i !== -1 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export async function detectInstaller(file: File, d: Defaults | null): Promise<Detected | null> {
  const cfg = d?.installer_detection;
  if (!cfg?.rules?.length) return null;
  const headLen = Math.min(file.size, cfg.scan_head_bytes ?? 8 * 1024 * 1024);
  const head = new Uint8Array(await file.slice(0, headLen).arrayBuffer());
  const tailStart = Math.max(headLen, file.size - (cfg.scan_tail_bytes ?? 1024 * 1024));
  const tail = tailStart < file.size ? new Uint8Array(await file.slice(tailStart).arrayBuffer()) : new Uint8Array();

  for (const r of cfg.rules as DetectionRule[]) {
    if (r.magic_hex) {
      const m = hex(r.magic_hex);
      if (head.length >= m.length && m.every((b, i) => head[i] === b)) return { label: r.label, type: r.type, silentArgs: r.silentArgs };
      continue;
    }
    if (r.text) {
      for (const needle of [ascii(r.text), utf16(r.text)])
        if (indexOf(head, needle) !== -1 || indexOf(tail, needle) !== -1) return { label: r.label, type: r.type, silentArgs: r.silentArgs };
    }
  }
  return null;
}
