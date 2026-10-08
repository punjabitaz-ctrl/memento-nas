import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { Persona } from '../types';

interface Item { to: string; label: string; icon: string }

const RECORD: Item = { to: '/record', label: 'Record a story', icon: '🎙️' };
const ADD: Item = { to: '/add', label: 'Add photos & files', icon: '📥' };
const WRITE: Item = { to: '/add?write=1', label: 'Write a story', icon: '✍️' };
const PROMPTS: Item = { to: '/prompts', label: 'Story prompts', icon: '💭' };
const STORIES: Item = { to: '/stories', label: 'All stories', icon: '📖' };
const MINE: Item = { to: '/stories?mine=1', label: 'My stories', icon: '🙋' };
const TIMELINE: Item = { to: '/timeline', label: 'Timeline', icon: '📅' };
const SEARCH: Item = { to: '/search', label: 'Search', icon: '🔍' };
const PEOPLE: Item = { to: '/people', label: 'People', icon: '👪' };
const DASH: Item = { to: '/dashboard', label: 'Dashboard', icon: '📊' };
const FAMILY: Item = { to: '/family', label: 'Family', icon: '👨‍👩‍👧‍👦' };
const SETTINGS: Item = { to: '/settings', label: 'Settings', icon: '⚙️' };
const HELP: Item = { to: '/help', label: 'Help & backup', icon: '❓' };

function sections(persona: Persona, canWrite: boolean): { title: string; items: Item[] }[] {
  const create = canWrite ? [RECORD, ADD, WRITE, PROMPTS] : [PROMPTS];
  if (persona === 'elder') {
    return [
      { title: 'Share', items: canWrite ? [RECORD, PROMPTS, MINE] : [PROMPTS] },
      { title: 'More', items: [STORIES, TIMELINE, SETTINGS, HELP] },
    ];
  }
  if (persona === 'explorer') {
    return [
      { title: 'Explore', items: [TIMELINE, SEARCH, PEOPLE, STORIES] },
      { title: 'Contribute', items: canWrite ? [RECORD, ADD, PROMPTS] : [PROMPTS] },
      { title: 'Tools', items: [DASH, SETTINGS, HELP] },
    ];
  }
  return [
    { title: 'Manage', items: [DASH, FAMILY, STORIES, PEOPLE] },
    { title: 'Create', items: create },
    { title: 'Explore', items: [TIMELINE, SEARCH] },
    { title: 'Tools', items: [SETTINGS, HELP] },
  ];
}

const TITLES: Record<string, string> = {
  record: 'Record a story', add: 'Add to the vault', prompts: 'Story prompts', stories: 'Stories', timeline: 'Timeline',
  search: 'Search', people: 'People', person: 'People', dashboard: 'Dashboard', family: 'Family', settings: 'Settings', help: 'Help & backup', memory: 'Memory',
};

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname, loc.search]);
  if (!user) return null;
  const canWrite = user.role !== 'viewer';
  const secs = sections(user.persona, canWrite);
  const roleLabel = user.role === 'owner' ? 'Vault owner' : user.role === 'contributor' ? 'Contributor' : 'View only';
  const title = TITLES[loc.pathname.split('/')[1]] || 'Memento';

  return (
    <div className="app-layout">
      <aside className={`sidebar ${open ? 'sidebar-expanded' : ''}`} aria-label="Main navigation">
        <div className="sidebar-header">
          <div className="sidebar-logo"><span className="logo-icon">🕯️</span><span className="logo-text">Memento</span></div>
        </div>
        <div className="sidebar-user">
          <div className="user-avatar"><span>{user.displayName.charAt(0).toUpperCase()}</span></div>
          <div className="user-info"><span className="user-name">{user.displayName}</span><span className="user-role">{roleLabel}</span></div>
        </div>
        <div className="sidebar-nav">
          {secs.map((s) => (
            <div className="nav-section" key={s.title}>
              <h3 className="nav-section-title">{s.title}</h3>
              <nav className="nav-items">
                {s.items.map((it) => (
                  <NavLink key={it.to} to={it.to} end className={() => {
                    const [path, q] = it.to.split('?');
                    const active = loc.pathname === path && (q ? loc.search.includes(q) : !loc.search.includes('mine=1') && !loc.search.includes('write=1'));
                    return `nav-item ${active ? 'nav-item-active' : ''}`;
                  }}>
                    <span className="nav-icon" aria-hidden="true">{it.icon}</span><span className="nav-label">{it.label}</span>
                  </NavLink>
                ))}
              </nav>
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          <button className="logout-button" onClick={async () => { await logout(); nav('/login'); }}>
            <span className="nav-icon" aria-hidden="true">🚪</span><span className="nav-label">Sign out</span>
          </button>
        </div>
      </aside>
      <div className={`backdrop ${open ? 'show' : ''}`} onClick={() => setOpen(false)} />
      <main className="main-content">
        <header className="topbar">
          <div className="row">
            <button className="menu-btn" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>☰</button>
            <h1 className="page-title" style={{ fontSize: 'var(--text-xl)' }}>{title}</h1>
          </div>
          <div className="topbar-actions">
            {canWrite && <button className="quick-record-btn btn btn-primary btn-small" onClick={() => nav('/record')}>🎙️ Record</button>}
          </div>
        </header>
        <div className="page-content"><Outlet /></div>
      </main>
    </div>
  );
}
