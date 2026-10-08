import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api';
import { useToast, useLoad, Spinner, Banner } from '../components/ui';
import MemoryForm from '../components/MemoryForm';
import { RecorderPanel, type RecordingResult } from '../components/Recorder';
import { useAuth } from '../auth/AuthContext';
import type { Memory } from '../types';

function useSavedHandler() {
  const nav = useNavigate();
  const toast = useToast();
  return (m: Memory) => {
    toast('Saved to the vault 🔒');
    nav(`/memory/${m.id}`);
  };
}

function ReadOnlyNotice() {
  return <Banner kind="info" title="View-only account">Your account can browse and listen, but not add stories. Ask the vault owner if you’d like to contribute.</Banner>;
}

export function RecordPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const promptId = params.get('prompt');
  const onSaved = useSavedHandler();
  const [rec, setRec] = useState<RecordingResult | null>(null);
  const onRecorded = useCallback((r: RecordingResult | null) => setRec(r), []);
  const { data: prompt, loading } = useLoad(async () => {
    if (promptId) return api.prompt(promptId);
    return (await api.weeklyPrompt()).prompt;
  }, [promptId]);

  if (user?.role === 'viewer') return <ReadOnlyNotice />;
  if (loading) return <Spinner />;

  return (
    <div className="record-page">
      {prompt && (
        <div className="record-prompt-card">
          <p className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>{promptId ? 'Your question' : 'This week’s question'}</p>
          <p style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', margin: '12px 0 20px' }}>“{prompt.text}”</p>
          <Link className="btn btn-ghost btn-small" to="/prompts">Pick a different question</Link>
        </div>
      )}
      {/* One recorder instance, always in the same place in the tree: remounting it would lose the recording. */}
      <RecorderPanel onRecorded={onRecorded} maxSeconds={30 * 60} />
      {rec && (
        <div className="stack" style={{ width: '100%', maxWidth: 720, marginTop: 24 }}>
          <h3>Add a few details <span className="muted small">(all optional)</span></h3>
          <MemoryForm mode="record" recording={rec} promptId={prompt?.id ?? null} promptText={prompt?.text ?? null} onSaved={onSaved} />
        </div>
      )}
    </div>
  );
}

export function AddPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const promptId = params.get('prompt');
  const write = params.get('write') === '1';
  const onSaved = useSavedHandler();
  const { data: prompt } = useLoad(async () => (promptId ? api.prompt(promptId) : null), [promptId]);
  if (user?.role === 'viewer') return <ReadOnlyNotice />;
  return (
    <div>
      <div className="page-header">
        <h2>{write ? 'Write a story' : 'Add photos, videos & documents'}</h2>
        <p>{write ? 'Type out a memory in your own words.' : 'Scan or upload old photos, recordings and papers. Each file is encrypted the moment it arrives.'}</p>
        <div className="page-header-actions">
          {write ? <Link className="btn btn-outline btn-small" to="/add">Upload files instead</Link> : <Link className="btn btn-outline btn-small" to="/add?write=1">Write a story instead</Link>}
        </div>
      </div>
      <MemoryForm key={write ? 'w' : 'a'} mode={write ? 'write' : 'add'} promptId={prompt?.id ?? null} promptText={prompt?.text ?? null} onSaved={onSaved} />
    </div>
  );
}
