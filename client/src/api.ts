import type {
  AppConfig, AskResult, Category, Decade, LightMemory, Member, Memory, Prompt, Stats, User,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fired on any 401 so the app can drop back to the sign-in screen. */
export const UNAUTHORIZED_EVENT = 'memento:unauthorized';

const HEADERS = { 'X-Requested-With': 'memento' };

async function parse<T>(res: Response): Promise<T> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const msg = (data as { error?: string } | null)?.error || `Something went wrong (${res.status}).`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { ...HEADERS }, credentials: 'same-origin' };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'Cannot reach your Memento server. Check that your NAS is on and try again.');
  }
  return parse<T>(res);
}

const get = <T>(u: string) => request<T>('GET', u);
const post = <T>(u: string, b?: unknown) => request<T>('POST', u, b ?? {});
const patch = <T>(u: string, b: unknown) => request<T>('PATCH', u, b);
const del = <T>(u: string) => request<T>('DELETE', u);

/** multipart upload with progress (fetch cannot report upload progress). */
export function upload(url: string, form: FormData, onProgress?: (pct: number) => void, method = 'POST'): Promise<{ memory: Memory }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('X-Requested-With', 'memento');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: lost connection to your Memento server.'));
    xhr.onload = () => {
      let data: { error?: string; memory?: Memory } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as { memory: Memory });
      if (xhr.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      reject(new ApiError(xhr.status, data.error || `Upload failed (${xhr.status}).`));
    };
    xhr.send(form);
  });
}

export interface MemoryFilter {
  type?: string; year?: string; person?: string; tag?: string; mine?: boolean; sort?: string; limit?: number; offset?: number;
}

const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  config: () => get<AppConfig>('/api/config'),
  status: () => get<{ initialized: boolean; authenticated: boolean }>('/api/auth/status'),
  me: () => get<{ user: User }>('/api/auth/me'),
  setup: (b: { login: string; displayName: string; password: string; persona: string }) => post<{ user: User }>('/api/auth/setup', b),
  login: (login: string, password: string) => post<{ user: User }>('/api/auth/login', { login, password }),
  logout: () => post<{ ok: boolean }>('/api/auth/logout'),
  updateMe: (b: Partial<Pick<User, 'displayName' | 'persona' | 'settings'>>) => patch<{ user: User }>('/api/auth/me', b),
  changePassword: (currentPassword: string, newPassword: string) => post<{ ok: boolean }>('/api/auth/password', { currentPassword, newPassword }),

  members: () => get<{ members: Member[] }>('/api/members'),
  addMember: (b: { login: string; displayName: string; password: string; role: string; persona?: string }) => post<{ member: Member }>('/api/members', b),
  updateMember: (id: string, b: Record<string, unknown>) => patch<{ member: Member }>(`/api/members/${id}`, b),

  memories: (f: MemoryFilter = {}) => get<{ total: number; memories: Memory[] }>(`/api/memories${qs({ ...f })}`),
  memory: (id: string) => get<{ memory: Memory; canEdit: boolean }>(`/api/memories/${id}`),
  updateMemory: (id: string, b: Record<string, unknown>) => patch<{ memory: Memory }>(`/api/memories/${id}`, b),
  deleteMemory: (id: string) => del<{ ok: boolean }>(`/api/memories/${id}`),
  organize: (id: string, useAI: boolean) => post<{ memory: Memory }>(`/api/memories/${id}/organize`, { useAI }),
  deleteMedia: (id: string, mediaId: string) => del<{ ok: boolean }>(`/api/memories/${id}/media/${mediaId}`),
  createMemory: (form: FormData, onProgress?: (p: number) => void) => upload('/api/memories', form, onProgress),
  addMedia: (id: string, form: FormData, onProgress?: (p: number) => void) => upload(`/api/memories/${id}/media`, form, onProgress),

  timeline: () => get<{ years: { year: number; count: number; memories: LightMemory[] }[]; undated: { count: number; memories: LightMemory[] } }>('/api/timeline'),
  gaps: () => get<{ decades: Decade[]; gaps: Decade[] }>('/api/timeline/gaps'),
  onThisDay: () => get<{ date: string; memories: LightMemory[] }>('/api/timeline/on-this-day'),
  stats: () => get<Stats>('/api/stats'),
  search: (q: string) => get<{ results: Memory[] }>(`/api/search${qs({ q })}`),
  people: () => get<{ people: { name: string; relationship: string; count: number }[] }>('/api/people'),
  tags: () => get<{ tags: { tag: string; count: number }[] }>('/api/tags'),
  narrate: (subject: string) => post<{ title: string; story: string; sources: { id: string; title: string }[] }>('/api/narrate', { subject }),

  categories: () => get<{ categories: Category[]; lifeStages: string[] }>('/api/prompts/categories'),
  prompts: (category?: string, unanswered?: boolean) => get<{ prompts: Prompt[] }>(`/api/prompts${qs({ category, unanswered })}`),
  prompt: (id: string) => get<{ prompts: Prompt[] }>('/api/prompts').then((r) => r.prompts.find((p) => p.id === id) || null),
  randomPrompt: (category?: string) => get<{ prompt: Prompt | null }>(`/api/prompts/random${qs({ category })}`),
  weeklyPrompt: () => get<{ prompt: Prompt | null; week?: string }>('/api/prompts/weekly'),
  addPrompt: (b: { text: string; category: string }) => post<{ prompt: Prompt }>('/api/prompts', b),
  votePrompt: (id: string) => post<{ prompt: Prompt }>(`/api/prompts/${id}/vote`),
  deletePrompt: (id: string) => del<{ ok: boolean }>(`/api/prompts/${id}`),

  ask: (question: string, lang: string) => post<AskResult>('/api/ask', { question, lang }),
  reportAnswer: (id: string) => post<{ ok: boolean }>(`/api/ask/${id}/report`),
  forwardQuestion: (id: string) => post<{ prompt: { id: string; text: string } }>(`/api/ask/${id}/forward`),
  transcribe: (id: string, overwrite = false) => post<{ queued: number; alreadyQueued?: boolean }>(`/api/memories/${id}/transcribe`, { overwrite }),
};
