import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

// ---- Toasts -----------------------------------------------------------
interface ToastItem { id: number; text: string; error?: boolean }
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const n = useRef(0);
  const push = useCallback((text: string, error?: boolean) => {
    const id = ++n.current;
    setItems((x) => [...x, { id, text, error }]);
    window.setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), error ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- Confirm modal (a styled replacement for window.confirm) -----------
export function ConfirmModal(props: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <h3>{props.title}</h3>
        <div className="muted">{props.body}</div>
        <div className="row">
          <button ref={ref} type="button" className="btn btn-ghost" onClick={props.onCancel}>Cancel</button>
          <button type="button" className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'}`} onClick={props.onConfirm} disabled={props.busy}>
            {props.busy ? 'Working…' : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Banner({ kind = 'info', title, children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; title?: string; children: ReactNode }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-screen" style={{ minHeight: 240 }}>
      <Loader2 className="loading-spinner" style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" />
      <p className="loading-text">{label}</p>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
      {children && <div className="page-header-actions">{children}</div>}
    </div>
  );
}

/** Small loader hook: runs `fn` on mount/when deps change and exposes state. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e: Error) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}
