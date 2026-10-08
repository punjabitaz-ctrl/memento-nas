import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import type { Persona } from '../types';
import { Banner } from '../components/ui';

const LANDING: Record<Persona, string> = { elder: '/record', archivist: '/dashboard', explorer: '/timeline' };

const PERSONAS: { id: Persona; icon: string; title: string; text: string }[] = [
  { id: 'archivist', icon: '📚', title: 'I’m organizing the family’s history', text: 'Dashboard, family members, collecting photos and stories.' },
  { id: 'elder', icon: '🎙️', title: 'I’m sharing my own stories', text: 'Big buttons. Record, answer a question, done.' },
  { id: 'explorer', icon: '🔍', title: 'I’m exploring our family’s past', text: 'Timeline, search, people and “on this day”.' },
];

export function Login() {
  const { user, config, setUser } = useAuth();
  const nav = useNavigate();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to={LANDING[user.persona]} replace />;
  if (config && !config.initialized) return <Navigate to="/setup" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user: u } = await api.login(login.trim(), password);
      setUser(u);
      nav(LANDING[u.persona], { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo">🕯️</div>
          <h1>Memento</h1>
          <p>Your family’s stories, kept safe at home.</p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <div className="form-group">
            <label className="form-label" htmlFor="login">Email or username</label>
            <input id="login" className="form-input" autoComplete="username" autoCapitalize="none" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="pw">Password</label>
            <input id="pw" type="password" className="form-input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="banner banner-error" role="alert">{error}</div>}
          <button className="btn btn-primary btn-large btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="auth-footer small">Forgot your password? Ask the vault owner to reset it from the Family page.</p>
      </div>
    </div>
  );
}

export function Setup() {
  const { user, config, setUser, refreshConfig } = useAuth();
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [persona, setPersona] = useState<Persona>('archivist');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to={LANDING[user.persona]} replace />;
  if (config?.initialized) return <Navigate to="/login" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user: u } = await api.setup({ login: login.trim(), displayName: displayName.trim(), password, persona });
      await refreshConfig();
      setUser(u);
      nav(LANDING[u.persona], { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 560 }}>
        <div className="auth-header">
          <div className="auth-logo">🕯️</div>
          <h1>Welcome to Memento</h1>
          <p>Let’s set up your family’s vault. You’ll be its owner.</p>
        </div>

        <Banner kind="warn" title="Before you start: your encryption key">
          Everything you add is locked with the <code>MEMENTO_KEY</code> in your server’s <code>.env</code> file. If that key is lost,
          the vault can never be opened again — not even by us. Make sure it is saved in a password manager <em>and</em> printed somewhere safe.
        </Banner>

        <form className="auth-form" onSubmit={submit}>
          <div className="form-group">
            <label className="form-label" htmlFor="dn">Your name</label>
            <input id="dn" className="form-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="lg">Email or username to sign in with</label>
            <input id="lg" className="form-input" value={login} onChange={(e) => setLogin(e.target.value)} required minLength={3} autoCapitalize="none" autoComplete="username" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="pw">Password</label>
            <input id="pw" type="password" className="form-input" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
            <p className="form-help">At least 10 characters. A short phrase of several words is easy to remember and hard to guess.</p>
          </div>
          <fieldset className="form-group" style={{ border: 'none', padding: 0 }}>
            <legend className="form-label">What will you mostly do?</legend>
            <div className="persona-pick">
              {PERSONAS.map((p) => (
                <label key={p.id}>
                  <input type="radio" name="persona" checked={persona === p.id} onChange={() => setPersona(p.id)} />
                  <span><strong>{p.icon} {p.title}</strong><br /><span className="muted small">{p.text}</span></span>
                </label>
              ))}
            </div>
            <p className="form-help">This only changes your menu and landing page. You can change it any time in Settings.</p>
          </fieldset>
          <label className="check" style={{ marginBottom: 20 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I have saved my <code>MEMENTO_KEY</code> somewhere safe.</span>
          </label>
          {error && <div className="banner banner-error" role="alert">{error}</div>}
          <button className="btn btn-primary btn-large btn-block" disabled={busy || !ack}>{busy ? 'Creating…' : 'Create my vault'}</button>
        </form>
      </div>
    </div>
  );
}
