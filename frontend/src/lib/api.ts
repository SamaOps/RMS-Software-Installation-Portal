import axios, { AxiosError } from 'axios';
import type {
  Analytics,
  Defaults,
  DeviceHit,
  HistoryDetail,
  HistoryRow,
  NamedRef,
  Software,
  SoftwarePayload,
} from './types';

const TOKEN_KEY = 'rms-portal-token';
const USER_KEY = 'rms-portal-user';

export const session = {
  get token() {
    return sessionStorage.getItem(TOKEN_KEY);
  },
  get user() {
    return sessionStorage.getItem(USER_KEY);
  },
  set(token: string, user: string) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(USER_KEY, user);
  },
  clear() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  },
};

export const http = axios.create({ baseURL: import.meta.env.VITE_API_URL || '' });

http.interceptors.request.use((cfg) => {
  const t = session.token;
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

http.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    if (err.response?.status === 401 && !err.config?.url?.includes('/auth/login')) {
      session.clear();
      if (!location.pathname.startsWith('/login')) location.assign('/login');
    }
    return Promise.reject(err);
  },
);

export interface FieldError {
  path: string;
  message: string;
}

/** Human-readable error + per-field validation errors from the API. */
export function apiError(err: unknown): { message: string; fields: FieldError[] } {
  if (axios.isAxiosError(err)) {
    const d = err.response?.data as { error?: string; fields?: FieldError[] } | undefined;
    if (d?.error) return { message: d.error, fields: d.fields ?? [] };
    if (!err.response) return { message: 'Cannot reach the server. Check your connection.', fields: [] };
    return { message: `Request failed (${err.response.status})`, fields: [] };
  }
  return { message: err instanceof Error ? err.message : String(err), fields: [] };
}

const data = <T>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data);

export const api = {
  login: (username: string, password: string) =>
    data<{ token: string; username: string }>(http.post('/api/admin/auth/login', { username, password })),

  listSoftwares: (params: Record<string, string | undefined>) =>
    data<Software[]>(http.get('/api/admin/softwares', { params })),
  getSoftware: (id: Software['id']) => data<Software>(http.get(`/api/admin/softwares/${id}`)),
  createSoftware: (p: SoftwarePayload) => data<Software>(http.post('/api/admin/softwares', p)),
  updateSoftware: (id: Software['id'], p: SoftwarePayload) => data<Software>(http.put(`/api/admin/softwares/${id}`, p)),
  setActive: (id: Software['id'], is_active: boolean) =>
    data<Software>(http.patch(`/api/admin/softwares/${id}/status`, { is_active })),
  setTestDevices: (id: Software['id'], serials: string[]) =>
    data<Software>(http.put(`/api/admin/softwares/${id}/test-devices`, { serials })),
  retry: (id: Software['id'], body: { serial_numbers?: string[]; all_failed?: boolean }) =>
    data<{ queued: number; serial_numbers: string[] }>(http.post(`/api/admin/softwares/${id}/retry`, body)),
  verifyChecksum: (id: Software['id']) =>
    http
      .post(`/api/admin/softwares/${id}/verify-checksum`, null, { validateStatus: (s) => s === 200 || s === 422 })
      .then((r) => r.data.data as { ok: boolean; expected: string; actual: string }),
  deleteSoftware: (id: Software['id']) => http.delete(`/api/admin/softwares/${id}`),
  clientScript: (id: Software['id']) =>
    http.get(`/api/admin/softwares/${id}/client-script`, { responseType: 'text', transformResponse: (x) => x }).then((r) => ({
      content: String(r.data),
      url: String(r.headers['x-script-url'] ?? ''),
      current: r.headers['x-script-current'] === 'true',
    })),
  publishClientScript: (id: Software['id']) => data<Software>(http.post(`/api/admin/softwares/${id}/client-script`)),

  donors: () => data<NamedRef[]>(http.get('/api/admin/lookups/donors')),
  ngos: () => data<NamedRef[]>(http.get('/api/admin/lookups/ngos')),
  devices: (search: string) => data<DeviceHit[]>(http.get('/api/admin/lookups/devices', { params: { search } })),
  defaults: () => data<Defaults>(http.get('/api/admin/lookups/installer-defaults')),

  analytics: () => data<Analytics>(http.get('/api/admin/analytics/status')),

  history: (params: Record<string, string | number | undefined>) =>
    http
      .get('/api/admin/history', { params })
      .then((r) => r.data as { data: HistoryRow[]; total: number; page: number; page_size: number }),
  historyDetail: (id: HistoryRow['id']) => data<HistoryDetail>(http.get(`/api/admin/history/${id}`)),

  /** Downloads the filtered install history as CSV (auth header required, so not a plain link). */
  exportHistory: async (params: Record<string, string | number | undefined>) => {
    const r = await http.get('/api/admin/history/export.csv', { params, responseType: 'blob' });
    const name = /filename="([^"]+)"/.exec(String(r.headers['content-disposition'] ?? ''))?.[1] ?? 'rms-install-history.csv';
    const url = URL.createObjectURL(r.data as Blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { truncated: r.headers['x-export-truncated'] ? Number(r.headers['x-export-truncated']) : null };
  },
};
