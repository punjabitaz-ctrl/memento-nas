import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Banner, EmptyState, PageHeader, Spinner, useLoad, useToast } from '../components/ui';
import type { Prompt } from '../types';

export default function PromptsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const canWrite = user?.role !== 'viewer';
  const [cat, setCat] = useState<string>('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [text, setText] = useState('');
  const [newCat, setNewCat] = useState('childhood');
  const [adding, setAdding] = useState(false);
  const cats = useLoad(() => api.categories(), []);
  const list = useLoad(() => api.prompts(cat || undefined, onlyNew), [cat, onlyNew]);
  const prompts = list.data?.prompts ?? [];

  async function vote(p: Prompt) {
    try {
      const { prompt } = await api.votePrompt(p.id);
      list.setData((d) => (d ? { prompts: d.prompts.map((x) => (x.id === p.id ? prompt : x)) } : d));
    } catch (e) { toast((e as Error).message, true); }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      await api.addPrompt({ text, category: newCat });
      setText('');
      toast('Question added for the family');
      list.reload();
    } catch (err) { toast((err as Error).message, true); }
    setAdding(false);
  }
  async function remove(p: Prompt) {
    try { await api.deletePrompt(p.id); list.reload(); } catch (e) { toast((e as Error).message, true); }
  }

  return (
    <div>
      <PageHeader title="Story prompts" subtitle="Good questions unlock good stories. Pick one and answer by voice or in writing." />
      {cats.data && (
        <div className="chips" role="group" aria-label="Filter by topic">
          <button className={`chip ${cat === '' ? 'active' : ''}`} onClick={() => setCat('')}>All topics</button>
          {cats.data.categories.map((c) => (
            <button key={c.id} className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)} title={c.description}>{c.icon} {c.name}</button>
          ))}
        </div>
      )}
      <label className="check" style={{ marginBottom: 24 }}>
        <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
        <span>Only show questions nobody has answered yet</span>
      </label>

      {list.loading ? <Spinner /> : list.error ? <Banner kind="error">{list.error}</Banner> : prompts.length === 0 ? (
        <EmptyState icon="💭" title="Nothing here"><p>Try another topic, or untick the filter above.</p></EmptyState>
      ) : (
        <div className="prompt-grid">
          {prompts.map((p) => {
            const c = cats.data?.categories.find((x) => x.id === p.category);
            return (
              <div className="prompt-card" key={p.id}>
                <div className="prompt-meta"><span>{c?.icon} {c?.name ?? p.category}</span>{p.isCustom && <span>✨ Added by family</span>}{p.answered > 0 && <span>✅ {p.answered} answered</span>}</div>
                <p className="prompt-text">{p.text}</p>
                <div className="row">
                  {canWrite && <Link className="btn btn-primary btn-small" to={`/record?prompt=${p.id}`}>🎙️ Answer by voice</Link>}
                  {canWrite && <Link className="btn btn-outline btn-small" to={`/add?write=1&prompt=${p.id}`}>✍️ Write it</Link>}
                  <button className="btn btn-ghost btn-small" onClick={() => vote(p)} aria-pressed={p.votedByMe} title="Mark as a question you'd love answered">{p.votedByMe ? '❤️' : '🤍'} {p.votes || ''}</button>
                  {p.isCustom && (p.createdBy === user?.id || user?.role === 'owner') && <button className="btn btn-ghost btn-small" onClick={() => remove(p)}>Remove</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {canWrite && (
        <div className="card" style={{ marginTop: 40, maxWidth: 640 }}>
          <h3 style={{ marginBottom: 12 }}>Suggest a question for the family</h3>
          <form onSubmit={add} className="stack">
            <div className="form-group"><label className="form-label" htmlFor="np">Your question</label>
              <input id="np" className="form-input" value={text} onChange={(e) => setText(e.target.value)} minLength={10} maxLength={500} required placeholder="What did the old farmhouse smell like?" /></div>
            <div className="form-group"><label className="form-label" htmlFor="nc">Topic</label>
              <select id="nc" className="form-input form-select" value={newCat} onChange={(e) => setNewCat(e.target.value)}>
                {cats.data?.categories.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
              </select></div>
            <button className="btn btn-primary" disabled={adding}>Add question</button>
          </form>
        </div>
      )}
    </div>
  );
}
