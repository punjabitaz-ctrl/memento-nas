import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Banner, EmptyState, PageHeader, Spinner, useLoad, useToast } from '../components/ui';
import { MemoryCard, toLight } from '../components/MemoryCard';
import { formatBytes, splitSnippet, TYPE_LABEL } from '../util';
import type { MemoryType } from '../types';

export function Dashboard() {
  const { user } = useAuth();
  const stats = useLoad(() => api.stats(), []);
  const weekly = useLoad(() => api.weeklyPrompt(), []);
  const today = useLoad(() => api.onThisDay(), []);
  const gaps = useLoad(() => api.gaps(), []);
  const recent = useLoad(() => api.memories({ sort: 'added', limit: 6 }), []);
  const canWrite = user?.role !== 'viewer';
  const s = stats.data;
  const wp = weekly.data?.prompt;

  return (
    <div>
      <PageHeader title={`Hello, ${user?.displayName.split(' ')[0] ?? 'there'}`} subtitle="Here’s how your family’s vault is growing." />
      {!window.isSecureContext && canWrite && (
        <Banner kind="warn" title="Voice recording is switched off on this address">
          Browsers only allow the microphone on secure (https://) addresses. You can still upload recordings. See Help → “Turn on HTTPS” to enable recording.
        </Banner>
      )}
      {wp && (
        <div className="hero-prompt">
          <p className="small" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.75 }}>This week’s question for the family</p>
          <p className="prompt-text">“{wp.text}”</p>
          <div className="row">
            {canWrite && <Link className="btn btn-primary" to={`/record?prompt=${wp.id}`}>🎙️ Answer by voice</Link>}
            {canWrite && <Link className="btn btn-outline" to={`/add?write=1&prompt=${wp.id}`}>✍️ Write it</Link>}
            <Link className="btn btn-ghost" style={{ color: 'inherit' }} to="/prompts">More questions</Link>
          </div>
        </div>
      )}
      {s && (
        <div className="stats-grid">
          <div className="stat-card"><div className="stat-icon">📖</div><div className="stat-value">{s.total}</div><div className="stat-label">Memories kept</div></div>
          <div className="stat-card"><div className="stat-icon">🆕</div><div className="stat-value">{s.thisMonth}</div><div className="stat-label">Added this month</div></div>
          <div className="stat-card"><div className="stat-icon">👪</div><div className="stat-value">{s.people}</div><div className="stat-label">People remembered</div></div>
          <div className="stat-card"><div className="stat-icon">🔒</div><div className="stat-value">{formatBytes(s.bytes)}</div><div className="stat-label">Encrypted in the vault</div></div>
          {s.firstYear && <div className="stat-card"><div className="stat-icon">⏳</div><div className="stat-value">{s.firstYear}–{s.lastYear}</div><div className="stat-label">Years covered</div></div>}
        </div>
      )}
      {s && s.total === 0 && (
        <EmptyState icon="🕯️" title="Your vault is empty. Let’s fill it.">
          <p>Start with one story: record a grandparent answering a question, or add a handful of old photos.</p>
          {canWrite && <div className="row" style={{ justifyContent: 'center' }}><Link className="btn btn-primary" to="/record">🎙️ Record a story</Link><Link className="btn btn-outline" to="/add">📥 Add photos</Link></div>}
        </EmptyState>
      )}
      {today.data && today.data.memories.length > 0 && (
        <section className="section"><h3>On this day</h3>
          <div className="memories-grid">{today.data.memories.map((m) => <MemoryCard key={m.id} m={m} />)}</div></section>
      )}
      {gaps.data && gaps.data.gaps.length > 0 && (
        <section className="section"><h3>Gaps worth filling</h3>
          <p className="muted" style={{ marginBottom: 12 }}>These decades have few or no memories yet. A good place to ask a relative for a story or dig out a shoebox of photos.</p>
          <div className="decade-bar">{gaps.data.gaps.map((d) => <div key={d.decade} className={`decade ${d.status}`}><strong>{d.label}</strong>{d.count === 0 ? 'nothing yet' : `${d.count} so far`}</div>)}</div>
        </section>
      )}
      {recent.data && recent.data.memories.length > 0 && (
        <section className="section"><div className="row-between"><h3>Recently added</h3><Link to="/stories">See all</Link></div>
          <div className="memories-grid">{recent.data.memories.map((m) => <MemoryCard key={m.id} m={toLight(m)} />)}</div></section>
      )}
    </div>
  );
}

export function Stories() {
  const [params, setParams] = useSearchParams();
  const mine = params.get('mine') === '1';
  const tag = params.get('tag') || undefined;
  const person = params.get('person') || undefined;
  const type = (params.get('type') as MemoryType | null) || undefined;
  const sort = params.get('sort') || 'memory';
  const [extra, setExtra] = useState<ReturnType<typeof toLight>[]>([]);
  const PAGE = 48;
  const { data, loading, error } = useLoad(async () => { setExtra([]); return api.memories({ mine, tag, person, type, sort, limit: PAGE }); }, [mine, tag, person, type, sort]);
  const [more, setMore] = useState(false);
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const items = [...(data?.memories.map(toLight) ?? []), ...extra];
  async function loadMore() {
    setMore(true);
    try { const r = await api.memories({ mine, tag, person, type, sort, limit: PAGE, offset: items.length }); setExtra((e) => [...e, ...r.memories.map(toLight)]); } finally { setMore(false); }
  }
  return (
    <div>
      <PageHeader title={mine ? 'My stories' : 'All stories'} subtitle={data ? `${data.total} ${data.total === 1 ? 'memory' : 'memories'}${tag ? ` tagged “${tag}”` : ''}${person ? ` with ${person}` : ''}` : undefined} />
      <div className="row" style={{ marginBottom: 24 }}>
        <select className="form-input form-select" style={{ width: 'auto' }} aria-label="Type" value={type ?? ''} onChange={(e) => set('type', e.target.value || null)}>
          <option value="">All types</option>
          {(Object.keys(TYPE_LABEL) as MemoryType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select className="form-input form-select" style={{ width: 'auto' }} aria-label="Sort" value={sort} onChange={(e) => set('sort', e.target.value)}>
          <option value="memory">Newest memories first</option><option value="oldest">Oldest memories first</option><option value="added">Recently added</option>
        </select>
        {(tag || person) && <button className="btn btn-ghost btn-small" onClick={() => { const p = new URLSearchParams(params); p.delete('tag'); p.delete('person'); setParams(p); }}>Clear filter ✕</button>}
      </div>
      {loading ? <Spinner /> : error ? <Banner kind="error">{error}</Banner> : items.length === 0 ? (
        <EmptyState icon="📖" title="No stories here yet"><p>Add the first one and it will appear here.</p><Link className="btn btn-primary" to="/record">Record a story</Link></EmptyState>
      ) : (
        <>
          <div className="memories-grid">{items.map((m) => <MemoryCard key={m.id} m={m} />)}</div>
          {data && items.length < data.total && <div className="center" style={{ marginTop: 32 }}><button className="btn btn-outline" onClick={loadMore} disabled={more}>{more ? 'Loading…' : 'Show more'}</button></div>}
        </>
      )}
    </div>
  );
}

export function Timeline() {
  const tl = useLoad(() => api.timeline(), []);
  const gaps = useLoad(() => api.gaps(), []);
  if (tl.loading) return <Spinner />;
  if (tl.error) return <Banner kind="error">{tl.error}</Banner>;
  const d = tl.data!;
  const empty = d.years.length === 0 && d.undated.count === 0;
  return (
    <div>
      <PageHeader title="Family timeline" subtitle="Every memory, in the order it happened." />
      {empty && <EmptyState icon="📅" title="The timeline is empty"><p>Add a memory with a year and it will appear here.</p><Link className="btn btn-primary" to="/add">Add a memory</Link></EmptyState>}
      {gaps.data && gaps.data.decades.length > 1 && (
        <div className="decade-bar" aria-label="Memories per decade">
          {gaps.data.decades.map((x) => <div key={x.decade} className={`decade ${x.status}`}><strong>{x.label}</strong>{x.count}</div>)}
        </div>
      )}
      {d.years.map((y) => (
        <section className="tl-year" key={y.year} id={`y${y.year}`}>
          <div className="tl-year-head"><h3>{y.year}</h3><span className="muted">{y.count} {y.count === 1 ? 'memory' : 'memories'}</span></div>
          <div className="memories-grid">{y.memories.map((m) => <MemoryCard key={m.id} m={m} />)}</div>
        </section>
      ))}
      {d.undated.count > 0 && (
        <section className="tl-year">
          <div className="tl-year-head"><h3>Date unknown</h3><span className="muted">{d.undated.count} to place on the timeline</span></div>
          <div className="memories-grid">{d.undated.memories.map((m) => <MemoryCard key={m.id} m={m} />)}</div>
        </section>
      )}
    </div>
  );
}

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const [text, setText] = useState(q);
  const res = useLoad(async () => (q.trim() ? (await api.search(q)).results : null), [q]);
  const tags = useLoad(() => api.tags(), []);
  return (
    <div>
      <PageHeader title="Search" subtitle="Find a story by a word, a name, a place or a year." />
      <form className="search-box" role="search" onSubmit={(e) => { e.preventDefault(); setParams(text.trim() ? { q: text.trim() } : {}); }}>
        <label className="sr-only" htmlFor="q">Search memories</label>
        <input id="q" className="form-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. apple pie, Grandma Rose, 1962" autoFocus />
        <button className="btn btn-primary">Search</button>
      </form>
      {res.loading && q ? <Spinner label="Searching…" /> : res.data ? (
        res.data.length === 0 ? <EmptyState icon="🔍" title={`Nothing found for “${q}”`}><p>Try a shorter word, or check the spelling of a name.</p></EmptyState> : (
          <>
            <p className="muted" style={{ marginBottom: 16 }}>{res.data.length} {res.data.length === 1 ? 'result' : 'results'}</p>
            <div className="memories-grid">
              {res.data.map((m) => (
                <MemoryCard key={m.id} m={toLight(m)} snippet={m.snippet ? <span className="snippet">{splitSnippet(m.snippet).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</span> : undefined} />
              ))}
            </div>
          </>
        )
      ) : tags.data && tags.data.tags.length > 0 && (
        <section className="section"><h3>Browse by tag</h3>
          <div className="tag-list">{tags.data.tags.map((t) => <span key={t.tag} className="tag"><Link to={`/stories?tag=${encodeURIComponent(t.tag)}`}>{t.tag} · {t.count}</Link></span>)}</div></section>
      )}
    </div>
  );
}

export function People() {
  const { data, loading, error } = useLoad(() => api.people(), []);
  if (loading) return <Spinner />;
  if (error) return <Banner kind="error">{error}</Banner>;
  const people = data?.people ?? [];
  return (
    <div>
      <PageHeader title="People" subtitle="Everyone who appears in your family’s stories." />
      {people.length === 0 ? <EmptyState icon="👪" title="No people yet"><p>Add names to a memory and they’ll appear here.</p></EmptyState> : (
        <div className="memories-grid">
          {people.map((p) => (
            <Link key={p.name} to={`/person/${encodeURIComponent(p.name)}`} className="card" style={{ color: 'inherit' }}>
              <div className="row-between"><h4>{p.name}</h4><span className="tag">{p.count}</span></div>
              {p.relationship && <p className="muted small">{p.relationship}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function Person() {
  const name = decodeURIComponent(useParams().name || '');
  const toast = useToast();
  const { data, loading } = useLoad(() => api.memories({ person: name, sort: 'oldest', limit: 200 }), [name]);
  const [story, setStory] = useState<{ title: string; story: string; sources: { id: string; title: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  async function narrate() {
    setBusy(true);
    try { setStory(await api.narrate(name)); } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  }
  return (
    <div>
      <PageHeader title={name} subtitle={data ? `${data.total} ${data.total === 1 ? 'memory' : 'memories'}` : undefined}>
        <button className="btn btn-primary" onClick={narrate} disabled={busy || !data?.total}>📜 Tell {name.split(' ').slice(-1)[0]}’s story</button>
        <Link className="btn btn-ghost" to="/people">All people</Link>
      </PageHeader>
      {story && (
        <div className="story-box section">
          <h3 style={{ marginBottom: 16 }}>{story.title}</h3>
          {story.story.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
          <p className="hint">Woven together from {story.sources.length} {story.sources.length === 1 ? 'memory' : 'memories'}, in order. Nothing leaves your NAS.</p>
        </div>
      )}
      {loading ? <Spinner /> : <div className="memories-grid">{data?.memories.map((m) => <MemoryCard key={m.id} m={toLight(m)} />)}</div>}
    </div>
  );
}
