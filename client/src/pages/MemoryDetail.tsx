import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Banner, ConfirmModal, Spinner, useLoad, useToast } from '../components/ui';
import { DateFields, dateToString, stringToDate } from '../components/MemoryForm';
import type { Memory } from '../types';
import { TYPE_ICON, TYPE_LABEL, editableDate, formatAdded, formatBytes, formatDuration, formatMemoryDate, parseCsv, parsePeople, peopleToText } from '../util';

export default function MemoryDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { config } = useAuth();
  const { data, loading, error, setData } = useLoad(() => api.memory(id), [id]);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<null | 'delete' | { media: string; name: string }>(null);
  const [busy, setBusy] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);

  if (loading) return <Spinner />;
  if (error || !data) return <Banner kind="error" title="Can’t open this memory">{error || 'It may have been removed, or it’s private to someone else.'} <Link to="/stories">Back to all stories</Link></Banner>;
  const { memory: m, canEdit } = data;
  const set = (mem: Memory) => setData({ memory: mem, canEdit });

  async function run<T>(fn: () => Promise<T>, ok?: string) {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const organize = (useAI: boolean) => run(async () => set((await api.organize(m.id, useAI)).memory), useAI ? 'Organized with Claude' : 'Organized');
  const remove = () => run(async () => { await api.deleteMemory(m.id); toast('Memory deleted'); nav('/stories'); });
  const removeFile = (mediaId: string) => run(async () => { await api.deleteMedia(m.id, mediaId); set((await api.memory(m.id)).memory); setConfirm(null); }, 'File removed');
  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const f = new FormData();
    for (const x of Array.from(files)) f.append('files', x, x.name);
    void run(async () => set((await api.addMedia(m.id, f)).memory), 'Files added');
  };

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 24 }}>
        <Link to="/stories">← All stories</Link>
        {canEdit && !editing && (
          <div className="row">
            <button className="btn btn-outline btn-small" onClick={() => setEditing(true)}>✏️ Edit</button>
            <button className="btn btn-ghost btn-small" onClick={() => fileIn.current?.click()} disabled={busy}>＋ Add files</button>
            <input ref={fileIn} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            <button className="btn btn-ghost btn-small" onClick={() => setConfirm('delete')}>🗑 Delete</button>
          </div>
        )}
      </div>

      {editing ? <EditForm m={m} onCancel={() => setEditing(false)} onSaved={(mem) => { set(mem); setEditing(false); toast('Saved'); }} /> : (
        <div className="detail">
          <div className="detail-media">
            <p className="small muted">{TYPE_ICON[m.type]} {TYPE_LABEL[m.type]}</p>
            <h2>{m.title || TYPE_LABEL[m.type]}</h2>
            {m.media.map((f) => (
              <figure key={f.id} style={{ margin: 0 }}>
                {f.kind === 'image' && <img src={f.url} alt={m.title || f.originalName} />}
                {f.kind === 'video' && <video controls preload="metadata" src={f.url} />}
                {f.kind === 'audio' && <div className="file-chip"><span aria-hidden="true">🎙️</span><div style={{ flex: 1 }}><audio controls preload="metadata" src={f.url} />{f.duration ? <p className="hint">{formatDuration(f.duration)}</p> : null}</div></div>}
                {f.kind === 'document' && <div className="file-chip"><span aria-hidden="true">📄</span><div style={{ flex: 1 }}>{f.originalName}<p className="hint">{formatBytes(f.size)}</p></div><a className="btn btn-outline btn-small" href={f.url} target="_blank" rel="noreferrer">Open</a></div>}
                <figcaption className="row hint" style={{ justifyContent: 'space-between' }}>
                  <span>{f.originalName} · {formatBytes(f.size)}</span>
                  <span className="row"><a href={`${f.url}?download=1`}>Download</a>{canEdit && <button className="btn-link" onClick={() => setConfirm({ media: f.id, name: f.originalName })}>Remove</button>}</span>
                </figcaption>
              </figure>
            ))}
            {m.description && <p style={{ fontSize: 'var(--text-lg)' }}>{m.description}</p>}
            {m.content && <div className="detail-story">{m.content}</div>}
            {m.transcript && <section><h4>Transcript</h4><div className="detail-story" style={{ fontSize: 'var(--text-base)' }}>{m.transcript}</div></section>}
            {!m.transcript && m.media.some((f) => f.kind === 'audio') && canEdit && (
              <Banner kind="info" title="Make this story searchable">Memento keeps everything on your NAS, so it doesn’t transcribe audio by itself. Press Edit and type or paste what was said, and every word becomes searchable.</Banner>
            )}
          </div>

          <aside className="stack">
            {m.aiSummary && <div className="card"><p className="small muted">{m.aiSource === 'claude' ? '✨ Summary by Claude' : 'Auto summary'}</p><p>{m.aiSummary}</p></div>}
            <div className="card">
              <ul className="meta-list">
                <li><span>When</span><span>{formatMemoryDate(m.memoryDate, m.datePrecision)}</span></li>
                {m.location && <li><span>Where</span><span>{m.location}</span></li>}
                <li><span>Added by</span><span>{m.contributor.displayName}</span></li>
                <li><span>Added</span><span>{formatAdded(m.createdAt)}</span></li>
                <li><span>Visible to</span><span>{m.privacy === 'private' ? '🔒 Just them' : 'Everyone in the family'}</span></li>
              </ul>
            </div>
            {m.people.length > 0 && <div className="card"><h4 style={{ marginBottom: 12 }}>People</h4>
              <div className="tag-list">{m.people.map((p) => <span className="tag" key={p.name}><Link to={`/person/${encodeURIComponent(p.name)}`}>{p.name}{p.relationship ? ` · ${p.relationship}` : ''}</Link></span>)}</div></div>}
            {m.tags.length > 0 && <div className="card"><h4 style={{ marginBottom: 12 }}>Tags</h4>
              <div className="tag-list">{m.tags.map((t) => <span className="tag" key={t}><Link to={`/stories?tag=${encodeURIComponent(t)}`}>{t}</Link></span>)}</div></div>}
            {canEdit && (
              <div className="card"><h4 style={{ marginBottom: 12 }}>Tidy up</h4>
                <p className="hint" style={{ marginBottom: 12 }}>Suggest tags, people, a date and a summary from the text.</p>
                <div className="row">
                  <button className="btn btn-outline btn-small" onClick={() => organize(false)} disabled={busy}>Organize (offline)</button>
                  {config?.aiAvailable && <button className="btn btn-outline btn-small" onClick={() => organize(true)} disabled={busy} title="Sends this item's text and first photo to Anthropic">✨ With Claude</button>}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {confirm === 'delete' && <ConfirmModal danger title="Delete this memory?" confirmLabel="Delete forever" busy={busy} onCancel={() => setConfirm(null)} onConfirm={remove}
        body={<>“{m.title || TYPE_LABEL[m.type]}” and its {m.media.length} {m.media.length === 1 ? 'file' : 'files'} will be permanently removed from the vault. This cannot be undone (except from a backup).</>} />}
      {confirm && confirm !== 'delete' && <ConfirmModal danger title="Remove this file?" confirmLabel="Remove file" busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => removeFile(confirm.media)}
        body={<>“{confirm.name}” will be removed from this memory.</>} />}
    </div>
  );
}

function EditForm({ m, onCancel, onSaved }: { m: Memory; onCancel: () => void; onSaved: (m: Memory) => void }) {
  const [f, setF] = useState({
    title: m.title, description: m.description, content: m.content, transcript: m.transcript, location: m.location,
    people: peopleToText(m.people), tags: m.tags.join(', '), privacy: m.privacy,
  });
  const [date, setDate] = useState(stringToDate(editableDate(m.memoryDate, m.datePrecision)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const up = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { memory } = await api.updateMemory(m.id, {
        title: f.title, description: f.description, content: f.content, transcript: f.transcript, location: f.location, privacy: f.privacy,
        memoryDate: dateToString(date), people: parsePeople(f.people), tags: parseCsv(f.tags),
      });
      onSaved(memory);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <form className="stack" style={{ maxWidth: 760 }} onSubmit={save}>
      <div className="form-group"><label className="form-label" htmlFor="e-t">Title</label><input id="e-t" className="form-input" value={f.title} onChange={up('title')} maxLength={200} /></div>
      <div className="form-group"><label className="form-label" htmlFor="e-d">Short description</label><textarea id="e-d" className="form-input" style={{ minHeight: 80 }} value={f.description} onChange={up('description')} /></div>
      <div className="form-group"><label className="form-label" htmlFor="e-c">Story</label><textarea id="e-c" className="form-input" style={{ minHeight: 200 }} value={f.content} onChange={up('content')} /></div>
      {m.media.some((x) => x.kind === 'audio' || x.kind === 'video') && (
        <div className="form-group"><label className="form-label" htmlFor="e-tr">Transcript <span className="muted">(type or paste what was said, so it can be searched)</span></label>
          <textarea id="e-tr" className="form-input" style={{ minHeight: 200 }} value={f.transcript} onChange={up('transcript')} /></div>
      )}
      <DateFields value={date} onChange={setDate} />
      <div className="grid-2">
        <div className="form-group"><label className="form-label" htmlFor="e-p">People</label><input id="e-p" className="form-input" value={f.people} onChange={up('people')} /></div>
        <div className="form-group"><label className="form-label" htmlFor="e-l">Place</label><input id="e-l" className="form-input" value={f.location} onChange={up('location')} /></div>
        <div className="form-group"><label className="form-label" htmlFor="e-g">Tags</label><input id="e-g" className="form-input" value={f.tags} onChange={up('tags')} /></div>
        <div className="form-group"><label className="form-label" htmlFor="e-v">Who can see this?</label>
          <select id="e-v" className="form-input form-select" value={f.privacy} onChange={up('privacy')}><option value="family">Everyone in the family</option><option value="private">Just me</option></select></div>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="row"><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button><button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
