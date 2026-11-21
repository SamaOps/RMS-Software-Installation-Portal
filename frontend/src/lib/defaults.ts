/**
 * Server-provided presets + limits (GET /api/admin/lookups/installer-defaults), fetched once
 * and shared. Nothing in the UI hard-codes installer flags, limits or exit-code hints; it all
 * comes from the backend's env and config/portal-presets.json.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import type { Defaults, InstallerType, ServerCapabilities } from './types';

let cache: Defaults | null = null;
let inflight: Promise<Defaults> | null = null;

export function loadDefaults(): Promise<Defaults> {
  if (cache) return Promise.resolve(cache);
  inflight ??= api
    .defaults()
    .then((d) => (cache = d))
    .finally(() => (inflight = null));
  return inflight;
}

export function useDefaults(): Defaults | null {
  const [d, setD] = useState<Defaults | null>(cache);
  useEffect(() => {
    if (!cache) loadDefaults().then(setD).catch(() => setD(null));
  }, []);
  return d;
}

export const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/** Installer type suggested for a file name, from the presets' default_type_by_extension map. */
export function guessInstallerType(name: string, d: Defaults | null): InstallerType | '' {
  const ext = extOf(name);
  return d?.default_type_by_extension?.[ext] ?? (d ? (Object.keys(d.installer_types)[0] as InstallerType) : '');
}

/** File-name rule matching the backend's (letters, digits, . _ - and an allowed extension). */
export function fileNameRegex(d: Defaults | null) {
  const exts = d?.allowed_extensions?.length ? d.allowed_extensions : ['[a-z0-9]{1,10}'];
  return new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\\.(${exts.join('|')})$`, 'i');
}

// ---------------------------------------------------------------------------
// What the connected RMS server can do. Features that only the optional server patch
// honours (single-laptop pilots, Retry, install priority, retry limit, minimum client
// version) are hidden unless the patch is detected, so the UI never offers no-ops.
// ---------------------------------------------------------------------------
let capsCache: ServerCapabilities | null = null;
let capsInflight: Promise<ServerCapabilities> | null = null;

export function loadServerCaps(): Promise<ServerCapabilities> {
  if (capsCache) return Promise.resolve(capsCache);
  capsInflight ??= api
    .rmsServer()
    .then((c) => (capsCache = c))
    .finally(() => (capsInflight = null));
  return capsInflight;
}

/** true when the RMS server runs the optional server patch. */
export function useServerPatch(): boolean {
  const [c, setC] = useState<ServerCapabilities | null>(capsCache);
  useEffect(() => {
    if (!capsCache) loadServerCaps().then(setC).catch(() => setC(null));
  }, []);
  return !!c?.device_targeting;
}
