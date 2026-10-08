import { useRef, useState, type DragEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import type { Memory } from '../types';
import { formatBytes, parseCsv, parsePeople } from '../util';
import { Banner } from './ui';
import type { RecordingResult } from './Recorder';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Year (required for a date) + optional month + optional day -> "1962" | "1962-06" | "1962-06-15". */
export function DateFields({ value, onChange }: { value: { y: string; m: string; d: string }; onChange: (v: { y: string; m: string; d: string }) => void }) {
  return (
    <fieldset style={{ border: 'none', padding: 0 }}>
      <legend className="form-label">When did this happen? <span className="muted">(optional, a guess is fine)</span></legend>
      <div className="date-fields">
        <input className="form-input" inputMode="numeric" maxLength={4} placeholder="Year, e.g. 1962" aria-label="Year"
          value={value.y} onChange={(e) => onChange({ ...value, y: e.target.value.replace(/\D/g, '') })} />
        <select className="form-input form-select" aria-label="Month" value={value.m} disabled={value.y.length !== 4}
          onChange={(e) => onChange({ ...value, m: e.target.value, d: e.target.value ? value.d : '' })}>
          <option value="">Month (if known)</option>
          {MONTHS.map((n, i) => <option key={n} value={String(i + 1).padStart(2, '0')}>{n}</option>)}
        </select>
        <input className="form-input" inputMode="numeric" maxLength={2} placeholder="Day" aria-label="Day" disabled={!value.m}
          value={value.d} onChange={(e) => onChange({ ...value, d: e.target.value.replace(/\D/g, '') })} />
      </div>
    </fieldset>
  );
}

export function dateToString(v: { y: string; m: string; d: string }): string {
  if (v.y.length !== 4) return '';
  if (!v.m) return v.y;
  if (!v.d) return `${v.y}-${v.m}`;
  return `${v.y}-${v.m}-${v.d.padStart(2, '0')}`;
}

export function stringToDate(s: string): { y: string; m: string; d: string } {
  const [y = '', m = '', d = ''] = s.split('-');
  return { y, m, d: d.replace(/^0/, '') };
}

interface Props {
  mode: 'record' | 'add' | 'write';
  recording?: RecordingResult | null;
  promptId?: string | null;
  promptText?: string | null;
  onSaved: (m: Memory) => void;
}

const ACCEPT = 'image/*,video/*,audio/*,.pdf,.txt,.md,.doc,.docx,.odt,.rtf,.heic,.heif';

export default function MemoryForm({ mode, recording, promptId, promptText, onSaved }: Props) {
  const { config } = useAuth();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [date, setDate] = useState({ y: '', m: '', d: '' });
  const [people, setPeople] = useState('');
  const [location, setLocation] = useState('');
  const [tags, setTags] = useState('');
  const [privacy, setPrivacy] = useState<'family' | 'private'>('family');
  const [useAI, setUseAI] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const maxBytes = (config?.maxFileMb ?? 500) * 1024 * 1024;
  const addFiles = (list: FileList | File[]) => {
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.size > maxBytes) { setError(`“${f.name}” is ${formatBytes(f.size)}, which is over the ${config?.maxFileMb} MB limit.`); continue; }
      next.push(f);
    }
    setFiles(next.slice(0, 20));
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); };

  const hasContent = mode === 'record' ? !!recording : !!(files.length || content.trim() || title.trim());
  const busy = progress !== null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const dateStr = dateToString(date);
    if (date.y && date.y.length !== 4) return setError('Please enter the year with four digits, like 1962.');
    const form = new FormData();
    // Text fields first: the server streams files straight into the vault as they arrive.
    const fields: Record<string, string> = { title, content, location, privacy, memoryDate: dateStr, tags: JSON.stringify(parseCsv(tags)), people: JSON.stringify(parsePeople(people)) };
    if (promptId) fields.promptId = promptId;
    if (useAI) fields.useAI = 'true';
    if (recording) { fields.type = 'voice_note'; fields.duration = String(recording.duration); }
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (recording) form.append('files', new File([recording.blob], `story-${new Date().toISOString().slice(0, 10)}.${recording.ext}`, { type: recording.mime }));
    for (const f of files) form.append('files', f, f.name);
    setProgress(0);
    try {
      const { memory } = await api.createMemory(form, (p) => setProgress(p));
      onSaved(memory);
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
    }
  }

  return (
    <form onSubmit={submit} className="stack" style={{ width: '100%', maxWidth: 720 }}>
      {promptText && mode !== 'record' && <Banner kind="info" title="Answering this question">“{promptText}”</Banner>}

      {mode === 'add' && (
        <div className={`dropzone ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <p style={{ fontSize: 'var(--text-lg)' }}>Drop photos, videos, recordings or documents here</p>
          <p className="hint">Up to 20 files, {config?.maxFileMb} MB each</p>
          <button type="button" className="btn btn-outline" style={{ marginTop: 16 }} onClick={() => input.current?.click()}>Choose files</button>
          <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          {files.length > 0 && (
            <ul className="file-list">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}><span>{f.name} <span className="muted">({formatBytes(f.size)})</span></span>
                  <button type="button" className="btn-link" onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button></li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="mf-title">Title <span className="muted">(optional)</span></label>
        <input id="mf-title" className="form-input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={mode === 'record' ? 'e.g. How Grandma made her apple pie' : 'e.g. Wedding day, June 1962'} />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="mf-content">{mode === 'write' ? 'Your story' : 'Notes or story'} {mode !== 'write' && <span className="muted">(optional)</span>}</label>
        <textarea id="mf-content" className="form-input" style={{ minHeight: mode === 'write' ? 280 : 120 }} value={content} onChange={(e) => setContent(e.target.value)}
          placeholder={mode === 'record' ? 'Anything you’d like to add in writing. You can also type out what was said so it can be searched.' : 'Who was there? What do you remember? Names, places and years help everyone find it later.'} />
      </div>

      <DateFields value={date} onChange={setDate} />

      <div className="grid-2">
        <div className="form-group">
          <label className="form-label" htmlFor="mf-people">People in it</label>
          <input id="mf-people" className="form-input" value={people} onChange={(e) => setPeople(e.target.value)} placeholder="Grandma Rose (grandmother), Uncle Joe" />
          <p className="form-help">Separate names with commas. Add a relationship in brackets if you like.</p>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="mf-loc">Place</label>
          <input id="mf-loc" className="form-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Pittsburgh, Pennsylvania" />
        </div>
      </div>

      <div className="grid-2">
        <div className="form-group">
          <label className="form-label" htmlFor="mf-tags">Tags</label>
          <input id="mf-tags" className="form-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="recipes, holidays" />
          <p className="form-help">Leave blank and Memento will suggest some.</p>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="mf-priv">Who can see this?</label>
          <select id="mf-priv" className="form-input form-select" value={privacy} onChange={(e) => setPrivacy(e.target.value as 'family' | 'private')}>
            <option value="family">Everyone in the family</option>
            <option value="private">Just me</option>
          </select>
        </div>
      </div>

      {config?.aiAvailable && (
        <label className="check">
          <input type="checkbox" checked={useAI} onChange={(e) => setUseAI(e.target.checked)} />
          <span>Ask Claude to help organize this one. <span className="muted">This sends this item’s text{mode === 'add' ? ' and its first photo' : ''} to Anthropic. Nothing else is ever sent.</span></span>
        </label>
      )}

      {error && <Banner kind="error">{error}</Banner>}
      {busy && (
        <div aria-live="polite">
          <div className="progress" role="progressbar" aria-valuenow={progress ?? 0} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${progress}%` }} /></div>
          <p className="hint">{progress === 100 ? 'Encrypting and filing it away…' : `Uploading… ${progress}%`}</p>
        </div>
      )}
      <div className="row">
        <button className="btn btn-primary btn-large" disabled={!hasContent || busy} type="submit">{busy ? 'Saving…' : 'Save to the vault'}</button>
      </div>
    </form>
  );
}
