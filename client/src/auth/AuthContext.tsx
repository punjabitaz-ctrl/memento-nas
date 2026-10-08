import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, UNAUTHORIZED_EVENT } from '../api';
import type { AppConfig, User, UserSettings } from '../types';

interface AuthState {
  user: User | null;
  config: AppConfig | null;
  loading: boolean;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
  saveSettings: (s: UserSettings) => Promise<void>;
  refreshConfig: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

/** Maps saved settings onto the stylesheet's accessibility classes (on <html>). */
export function applySettings(s: UserSettings | undefined) {
  const root = document.documentElement;
  root.classList.toggle('text-size-large', s?.textSize === 'large');
  root.classList.toggle('text-size-xl', s?.textSize === 'extra-large');
  root.classList.toggle('high-contrast', !!s?.highContrast);
  root.classList.toggle('reduced-motion', !!s?.reducedMotion);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const setUser = useCallback((u: User | null) => {
    setUserState(u);
    applySettings(u?.settings);
  }, []);

  const refreshConfig = useCallback(async () => {
    setConfig(await api.config());
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await api.config();
        if (!alive) return;
        setConfig(cfg);
        if (cfg.initialized) {
          const st = await api.status();
          if (st.authenticated) {
            const me = await api.me();
            if (alive) setUser(me.user);
          }
        }
      } catch {
        /* server unreachable: the login screen explains this */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    const onUnauth = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauth);
    return () => {
      alive = false;
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauth);
    };
  }, [setUser]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, [setUser]);

  // Optimistic: the checkbox/size change shows instantly; roll back only if the server rejects it.
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const saveSettings = useCallback(async (patch: UserSettings) => {
    const prev = userRef.current;
    if (prev) setUser({ ...prev, settings: { ...prev.settings, ...patch } });
    try {
      const { user: u } = await api.updateMe({ settings: patch });
      setUser(u);
    } catch (e) {
      if (prev) setUser(prev);
      throw e;
    }
  }, [setUser]);

  const value = useMemo(() => ({ user, config, loading, setUser, logout, saveSettings, refreshConfig }), [user, config, loading, setUser, logout, saveSettings, refreshConfig]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
