import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Banner, PageHeader, useToast } from '../components/ui';
import { formatMemoryDate } from '../util';
import type { AskCitation, AskResult } from '../types';

/** Turns "[S1]" markers into links to the memory they cite. A marker with no matching source renders nothing. */
function renderAnswer(text: string, cites: AskCitation[]) {
  return text.split(/(\[S\d+\])/g).map((part, i) => {
    const m = /^\[S(\d+)\]$/.exec(part);
    if (!m) return part;
    const c = cites.find((x) => x.label === `S${m[1]}`);
    return c ? (
      <Link key={i} to={`/memory/${c.memoryId}`} aria-label={`Source: ${c.title || 'memory'}`}>[{m[1]}]</Link>
    ) : null;
  });
}

export default function AskPage() {
  const toast = useToast();
  const { user } = useAuth();
  const canWrite = !!user && user.role !== 'viewer';
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AskResult | null>(null);
  const [asked, setAsked] = useState('');
  const [forwarded, setForwarded] = useState(false);
  const [reported, setReported] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setRes(null);
    setForwarded(false);
    setReported(false);
    try {
      setAsked(q.trim());
      setRes(await api.ask(q.trim(), navigator.language.split('-')[0] || 'en'));
    } catch (err) {
      toast((err as Error).message, true);
    }
    setBusy(false);
  }

  async function forward() {
    if (!res) return;
    try {
      await api.forwardQuestion(res.id);
      setForwarded(true);
      toast('Your question was added to the family prompts');
    } catch (err) { toast((err as Error).message, true); }
  }

  async function report() {
    if (!res) return;
    try {
      await api.reportAnswer(res.id);
      setReported(true);
      toast('Thanks. This answer was flagged for review');
    } catch (err) { toast((err as Error).message, true); }
  }

  return (
    <div className="stack">
      <PageHeader title="Ask the archive" subtitle="Answers come only from stories your family has saved, and every answer shows where it came from." />
      <form className="card stack" onSubmit={submit}>
        <div className="form-group">
          <label className="form-label" htmlFor="ask-q">What would you like to know?</label>
          <input id="ask-q" className="form-input" value={q} onChange={(e) => setQ(e.target.value)} maxLength={500}
            placeholder="Where did Grandma grow up? What was the wedding like?" />
        </div>
        <div className="row"><button className="btn btn-primary" disabled={busy || q.trim().length < 3}>{busy ? 'Looking…' : 'Ask'}</button></div>
      </form>

      <div className="stack" aria-live="polite">
        {res && res.degraded && (
          <Banner kind="warn" title="Searching by words only">The AI helper is switched off right now, so results may miss stories that use different words.</Banner>
        )}

        {res && res.outcome === 'answered' && (
          <section className="card stack">
            <p style={{ fontSize: 'var(--text-lg)' }}>{renderAnswer(res.answer, res.citations)}</p>
            <div>
              <h4>Where this came from</h4>
              <ul>
                {res.citations.map((c) => (
                  <li key={c.label}>
                    [{c.label.slice(1)}] <Link to={`/memory/${c.memoryId}`}>{c.title || 'Untitled memory'}</Link>
                    {c.memoryDate ? <span className="muted"> · {formatMemoryDate(c.memoryDate, c.datePrecision)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
            <div className="row">
              <button type="button" className="btn btn-ghost btn-small" onClick={report} disabled={reported}>{reported ? 'Reported' : 'This looks wrong'}</button>
            </div>
          </section>
        )}

        {res && res.outcome === 'no_record' && (
          <section className="card stack">
            <h3>The archive has no record of that yet</h3>
            <p>Nobody has shared a story that answers “{asked}”.{canWrite ? ' You can ask the family to record one.' : ''}</p>
            {res.excludedPrivate > 0 && <p className="small muted">Some of your private stories matched but were not used, because private stories never leave your NAS.</p>}
            {canWrite && (
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={forward} disabled={forwarded}>{forwarded ? 'Sent to the family' : 'Ask an elder to record this'}</button>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
