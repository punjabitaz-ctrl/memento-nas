import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Banner, PageHeader, Spinner, useLoad, useToast, ConfirmModal } from '../components/ui';
import type { Member, Persona, Role, UserSettings } from '../types';

const ROLE_LABEL: Record<Role, string> = { owner: 'Vault owner', contributor: 'Contributor', viewer: 'View only' };

export function Family() {
  const { user } = useAuth();
  const toast = useToast();
  const isOwner = user?.role === 'owner';
  const { data, loading, reload } = useLoad(() => api.members(), []);
  const [form, setForm] = useState({ displayName: '', login: '', password: '', role: 'contributor', persona: 'explorer' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reset, setReset] = useState<Member | null>(null);
  const [newPw, setNewPw] = useState('');

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.addMember(form);
      toast(`${form.displayName} can now sign in`);
      setForm({ displayName: '', login: '', password: '', role: 'contributor', persona: 'explorer' });
      reload();
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }
  async function patch(m: Member, body: Record<string, unknown>, ok: string) {
    try { await api.updateMember(m.id, body); toast(ok); reload(); } catch (err) { toast((err as Error).message, true); }
  }

  if (loading) return <Spinner />;
  return (
    <div>
      <PageHeader title="Family" subtitle={isOwner ? 'Invite relatives to add and browse memories. There’s no email involved: you create each account and share the password in person.' : 'The people who share this vault.'} />
      <div className="card" style={{ maxWidth: 760, marginBottom: 32 }}>
        {data?.members.map((m) => (
          <div className={`member-row ${m.disabled ? 'disabled' : ''}`} key={m.id}>
            <div><strong>{m.displayName}</strong> {m.id === user?.id && <span className="tag">you</span>}<br />
              <span className="muted small">{ROLE_LABEL[m.role]}{m.login ? ` · ${m.login}` : ''}{m.disabled ? ' · access paused' : ''}</span></div>
            {isOwner && m.id !== user?.id && (
              <div className="row">
                <select className="form-input form-select" style={{ width: 'auto', minHeight: 44, padding: '6px 40px 6px 12px' }} aria-label={`Role for ${m.displayName}`} value={m.role}
                  onChange={(e) => patch(m, { role: e.target.value }, 'Role updated')}>
                  <option value="owner">Vault owner</option><option value="contributor">Contributor</option><option value="viewer">View only</option>
                </select>
                <button className="btn btn-ghost btn-small" onClick={() => { setReset(m); setNewPw(''); }}>Reset password</button>
                <button className="btn btn-ghost btn-small" onClick={() => patch(m, { disabled: !m.disabled }, m.disabled ? 'Access restored' : 'Access paused')}>{m.disabled ? 'Restore' : 'Pause'}</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {isOwner && (
        <div className="card" style={{ maxWidth: 760 }}>
          <h3 style={{ marginBottom: 16 }}>Add a family member</h3>
          <form className="stack" onSubmit={add}>
            <div className="grid-2">
              <div className="form-group"><label className="form-label" htmlFor="m-n">Their name</label><input id="m-n" className="form-input" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></div>
              <div className="form-group"><label className="form-label" htmlFor="m-l">Sign-in name</label><input id="m-l" className="form-input" required minLength={3} autoCapitalize="none" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
                <p className="form-help">An email or a simple username, like “grandpa-joe”.</p></div>
              <div className="form-group"><label className="form-label" htmlFor="m-p">Starting password</label><input id="m-p" className="form-input" required minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                <p className="form-help">At least 10 characters. They can change it in Settings.</p></div>
              <div className="form-group"><label className="form-label" htmlFor="m-r">What can they do?</label>
                <select id="m-r" className="form-input form-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="contributor">Add and browse stories</option><option value="viewer">Browse and listen only</option></select></div>
            </div>
            <div className="form-group"><label className="form-label" htmlFor="m-pe">Their home screen</label>
              <select id="m-pe" className="form-input form-select" value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value as Persona })}>
                <option value="elder">Simple: record and answer questions</option><option value="explorer">Explorer: timeline and search</option><option value="archivist">Organizer: dashboard and family tools</option></select></div>
            {error && <Banner kind="error">{error}</Banner>}
            <button className="btn btn-primary" disabled={busy}>Create account</button>
          </form>
        </div>
      )}

      {reset && (
        <ConfirmModal title={`Reset ${reset.displayName}’s password`} confirmLabel="Set new password"
          onCancel={() => setReset(null)}
          onConfirm={async () => { await patch(reset, { password: newPw }, 'Password changed'); setReset(null); }}
          body={<div className="form-group"><label className="form-label" htmlFor="rp">New password (10+ characters)</label>
            <input id="rp" className="form-input" value={newPw} onChange={(e) => setNewPw(e.target.value)} minLength={10} autoFocus /></div>} />
      )}
    </div>
  );
}

export function Settings() {
  const { user, config, setUser, saveSettings } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.displayName ?? '');
  const [persona, setPersona] = useState<Persona>(user?.persona ?? 'archivist');
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pwErr, setPwErr] = useState<string | null>(null);
  const s: UserSettings = user?.settings ?? {};

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    try { const { user: u } = await api.updateMe({ displayName: name, persona }); setUser(u); toast('Profile saved'); } catch (err) { toast((err as Error).message, true); }
  }
  async function changePw(e: React.FormEvent) {
    e.preventDefault(); setPwErr(null);
    try { await api.changePassword(cur, pw); setCur(''); setPw(''); toast('Password changed'); } catch (err) { setPwErr((err as Error).message); }
  }
  const set = (patch: UserSettings) => saveSettings(patch).catch((e: Error) => toast(e.message, true));

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <PageHeader title="Settings" />
      <section className="card">
        <h3 style={{ marginBottom: 16 }}>Easier to see and use</h3>
        <div className="form-group"><label className="form-label" htmlFor="ts">Text size</label>
          <select id="ts" className="form-input form-select" value={s.textSize ?? 'normal'} onChange={(e) => set({ textSize: e.target.value as UserSettings['textSize'] })}>
            <option value="normal">Normal</option><option value="large">Large</option><option value="extra-large">Extra large</option></select></div>
        <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={!!s.highContrast} onChange={(e) => set({ highContrast: e.target.checked })} /><span>High contrast (darker text on white)</span></label>
        <label className="check"><input type="checkbox" checked={!!s.reducedMotion} onChange={(e) => set({ reducedMotion: e.target.checked })} /><span>Reduce animation</span></label>
        <p className="hint">These follow you to any device you sign in on.</p>
      </section>

      <section className="card">
        <h3 style={{ marginBottom: 16 }}>Your profile</h3>
        <form className="stack" onSubmit={saveProfile}>
          <div className="form-group"><label className="form-label" htmlFor="sn">Name</label><input id="sn" className="form-input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></div>
          <div className="form-group"><label className="form-label" htmlFor="sp">Home screen</label>
            <select id="sp" className="form-input form-select" value={persona} onChange={(e) => setPersona(e.target.value as Persona)}>
              <option value="elder">Simple: record and answer questions</option><option value="explorer">Explorer: timeline and search</option><option value="archivist">Organizer: dashboard and family tools</option></select></div>
          <button className="btn btn-primary">Save</button>
        </form>
      </section>

      <section className="card">
        <h3 style={{ marginBottom: 16 }}>Change password</h3>
        <form className="stack" onSubmit={changePw}>
          <div className="form-group"><label className="form-label" htmlFor="cp">Current password</label><input id="cp" type="password" className="form-input" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></div>
          <div className="form-group"><label className="form-label" htmlFor="np">New password</label><input id="np" type="password" className="form-input" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} required /></div>
          {pwErr && <Banner kind="error">{pwErr}</Banner>}
          <button className="btn btn-outline">Change password</button>
        </form>
      </section>

      <section className="card">
        <h3 style={{ marginBottom: 8 }}>Take everything with you</h3>
        <p className="muted" style={{ marginBottom: 16 }}>Download a zip of every memory you can see: original photos, recordings and documents (decrypted), plus a readable copy of every story. This is your estate hand-over copy. Keep it somewhere safe, because it is <strong>not</strong> encrypted.</p>
        <a className="btn btn-outline" href="/api/export" download>⬇️ Download my export</a>
      </section>

      <section className="card">
        <h3 style={{ marginBottom: 8 }}>About this vault</h3>
        <ul className="meta-list">
          <li><span>Version</span><span>{config?.version}</span></li>
          <li><span>Encryption</span><span>AES-256-GCM, on your NAS</span></li>
          <li><span>AI helper</span><span>{config?.aiAvailable ? 'Claude available, only when you tick the box on an item' : 'Offline only (nothing leaves your NAS)'}</span></li>
          <li><span>Largest file</span><span>{config?.maxFileMb} MB</span></li>
        </ul>
      </section>
    </div>
  );
}

export function Help() {
  return (
    <div style={{ maxWidth: 780 }} className="stack">
      <PageHeader title="Help & backup" subtitle="The few things worth knowing about running a vault at home." />

      <section className="card">
        <h3>🔑 The one thing you must not lose</h3>
        <p>Every file is locked with a secret key called <code>MEMENTO_KEY</code>, kept in the <code>.env</code> file next to your Memento install. <strong>If it’s lost, nobody can ever open the vault again</strong> — there is no reset and no back door. Keep a copy in a password manager <em>and</em> a printed copy in a safe or with someone you trust. Do not store it only on the NAS.</p>
      </section>

      <section className="card">
        <h3>💾 Backing up</h3>
        <p>Back up the two data folders <strong>together</strong>, on a schedule: <code>vault</code> (the encrypted files) and <code>db</code> (titles, dates, search). On Synology, add them to a Hyper Backup task pointed at a different drive or the cloud. The backup is useless without the key, so store the key separately. A backup you have never restored from is only a hope: try restoring once to a spare folder.</p>
      </section>

      <section className="card" id="https">
        <h3>🔒 Turn on HTTPS (needed for recording)</h3>
        <p>Browsers only let a page use the microphone over <code>https://</code>. Until HTTPS is on, voice recording is disabled, but uploading recordings from a phone works fine. The easiest ways:</p>
        <ul style={{ margin: '12px 0 0 20px' }}>
          <li><strong>Synology:</strong> Control Panel → Login Portal → Advanced → Reverse Proxy. Create a rule from HTTPS (port 443) to <code>localhost:3002</code>, attach a certificate under Security → Certificate (a free Synology DDNS name such as <code>yourname.synology.me</code> works), and set <code>TRUST_PROXY=true</code> in <code>.env</code>.</li>
          <li><strong>Tailscale:</strong> install it on the NAS and phones, then run <code>tailscale serve --https=443 localhost:3002</code>. Free, private, no ports opened to the internet.</li>
          <li><strong>Other NAS:</strong> Nginx Proxy Manager or Traefik (see the README).</li>
        </ul>
      </section>

      <section className="card">
        <h3>🙋 Common questions</h3>
        <dl className="stack">
          <div><dt><strong>Someone forgot their password.</strong></dt><dd className="muted">The vault owner can set a new one on the Family page.</dd></div>
          <div><dt><strong>The owner forgot theirs.</strong></dt><dd className="muted">On the NAS: <code>docker exec -it memento node scripts/reset-password.js --list</code> shows accounts; then run it again with a login and a new password.</dd></div>
          <div><dt><strong>Can I listen to a story and read the words?</strong></dt><dd className="muted">Yes. Memento can’t transcribe audio by itself (that would need cloud services). Press Edit on a voice story and type or paste the words in, and they become searchable.</dd></div>
          <div><dt><strong>Who can see my “Just me” stories?</strong></dt><dd className="muted">Only you, not even the vault owner. They are still encrypted and included in the NAS backup.</dd></div>
          <div><dt><strong>What leaves the NAS?</strong></dt><dd className="muted">Nothing, unless the owner added an Anthropic key <em>and</em> you tick “Ask Claude to help organize this” on a specific item.</dd></div>
        </dl>
      </section>
    </div>
  );
}
