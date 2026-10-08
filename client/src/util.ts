import type { DatePrecision, MemoryType } from './types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "1962" / "June 1962" / "June 15, 1962" depending on how precisely the date is known. */
export function formatMemoryDate(date: string | null, precision: DatePrecision): string {
  if (!date) return 'Date unknown';
  const [y, m, d] = date.split('-');
  if (precision === 'year') return y;
  if (precision === 'month') return `${MONTHS[+m - 1]} ${y}`;
  return `${MONTHS[+m - 1]} ${+d}, ${y}`;
}

/** The value to put back in a date input/text box for editing. */
export function editableDate(date: string | null, precision: DatePrecision): string {
  if (!date) return '';
  return precision === 'year' ? date.slice(0, 4) : precision === 'month' ? date.slice(0, 7) : date;
}

export function formatAdded(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const TYPE_ICON: Record<MemoryType, string> = {
  voice_note: '🎙️', photo: '📷', video: '🎬', text_note: '✍️', document: '📄',
};
export const TYPE_LABEL: Record<MemoryType, string> = {
  voice_note: 'Voice story', photo: 'Photo', video: 'Video', text_note: 'Written story', document: 'Document',
};

export function parseCsv(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/** Free-text people box: "Grandma Rose (grandmother), Uncle Joe" -> [{name, relationship}] */
export function parsePeople(s: string): { name: string; relationship: string }[] {
  return parseCsv(s).map((chunk) => {
    const m = chunk.match(/^(.*?)\s*\((.*?)\)\s*$/);
    return m ? { name: m[1].trim(), relationship: m[2].trim() } : { name: chunk, relationship: '' };
  }).filter((p) => p.name);
}

export function peopleToText(people: { name: string; relationship: string }[]): string {
  return people.map((p) => (p.relationship ? `${p.name} (${p.relationship})` : p.name)).join(', ');
}

/** Renders FTS snippets that mark matches with \u0001 ... \u0002 (never HTML). */
export function splitSnippet(s: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let hit = false;
  let buf = '';
  for (const ch of s) {
    if (ch === '\u0001' || ch === '\u0002') {
      if (buf) out.push({ text: buf, hit });
      buf = '';
      hit = ch === '\u0001';
    } else buf += ch;
  }
  if (buf) out.push({ text: buf, hit: false });
  return out;
}

export const isSecureForMic = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
