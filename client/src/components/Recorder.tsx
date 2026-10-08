import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mic, Pause, Play, Square, X } from 'lucide-react';
import { formatDuration, isSecureForMic } from '../util';

export interface RecordingResult {
  blob: Blob;
  duration: number;
  mime: string;
  ext: string;
}

// Safari/iPhone cannot record WebM, so negotiate: WebM/Opus first, then MP4 (AAC), then Ogg.
const CANDIDATES: [string, string][] = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/webm', 'webm'],
  ['audio/mp4', 'm4a'],
  ['audio/ogg;codecs=opus', 'ogg'],
];

function pickFormat(): { mime: string; ext: string } {
  for (const [m, ext] of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext };
    } catch {
      /* ignore */
    }
  }
  return { mime: '', ext: 'webm' };
}

const QUIET_AFTER_MS = 15_000;
const SOUND_RMS = 0.015;

type State = 'idle' | 'recording' | 'paused';

function useRecorder(maxSeconds: number) {
  const [state, setState] = useState<State>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [quiet, setQuiet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecordingResult | null>(null);

  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const segStart = useRef(0);
  const acc = useRef(0); // ms recorded before the current segment (pauses)
  const lastSound = useRef(0);
  const fmt = useRef({ mime: '', ext: 'webm' });
  const stateRef = useRef<State>('idle');
  const finish = useRef<((r: RecordingResult | null) => void) | null>(null);

  const setS = (s: State) => {
    stateRef.current = s;
    setState(s);
  };

  const teardown = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    ctx.current?.close().catch(() => {});
    ctx.current = null;
    analyser.current = null;
  }, []);

  const elapsedMs = () => acc.current + (stateRef.current === 'recording' ? performance.now() - segStart.current : 0);

  const stop = useCallback((): Promise<RecordingResult | null> => {
    return new Promise((resolve) => {
      const r = rec.current;
      if (!r || r.state === 'inactive') return resolve(null);
      const duration = Math.max(1, Math.round(elapsedMs() / 1000));
      finish.current = resolve;
      r.onstop = () => {
        const blob = new Blob(chunks.current, { type: fmt.current.mime || r.mimeType || 'audio/webm' });
        const out: RecordingResult = { blob, duration, mime: blob.type || 'audio/webm', ext: fmt.current.ext };
        teardown();
        setS('idle');
        setLevel(0);
        setQuiet(false);
        setResult(out);
        finish.current?.(out);
        finish.current = null;
      };
      r.stop();
    });
  }, [teardown]);

  const tick = useCallback(() => {
    const ms = elapsedMs();
    setElapsed(Math.floor(ms / 1000));
    const a = analyser.current;
    if (a) {
      const buf = new Uint8Array(a.fftSize);
      a.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / buf.length);
      setLevel(Math.min(1, rms * 4));
      if (rms > SOUND_RMS) lastSound.current = performance.now();
    }
    setQuiet(stateRef.current === 'recording' && performance.now() - lastSound.current > QUIET_AFTER_MS);
    if (ms >= maxSeconds * 1000 && stateRef.current === 'recording') void stop();
  }, [maxSeconds, stop]);

  const start = useCallback(async () => {
    setError(null);
    setResult(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = s;
      fmt.current = pickFormat();
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        ctx.current = new AC();
        await ctx.current.resume().catch(() => {});
        analyser.current = ctx.current.createAnalyser();
        analyser.current.fftSize = 1024;
        ctx.current.createMediaStreamSource(s).connect(analyser.current);
      }
      chunks.current = [];
      const r = new MediaRecorder(s, fmt.current.mime ? { mimeType: fmt.current.mime } : undefined);
      r.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      rec.current = r;
      acc.current = 0;
      segStart.current = performance.now();
      lastSound.current = performance.now();
      r.start(1000);
      setS('recording');
      setElapsed(0);
      timer.current = window.setInterval(tick, 100);
    } catch (e) {
      teardown();
      const name = (e as Error).name;
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access was blocked. Tap the lock icon in your browser’s address bar, allow the microphone, then try again.'
          : name === 'NotFoundError'
            ? 'No microphone was found on this device.'
            : 'Could not start recording. Please try again.'
      );
    }
  }, [teardown, tick]);

  const pause = useCallback(() => {
    if (stateRef.current !== 'recording' || !rec.current) return;
    acc.current += performance.now() - segStart.current;
    rec.current.pause();
    setS('paused');
    setQuiet(false);
  }, []);

  const resume = useCallback(() => {
    if (stateRef.current !== 'paused' || !rec.current) return;
    segStart.current = performance.now();
    lastSound.current = performance.now();
    rec.current.resume();
    setS('recording');
  }, []);

  const cancel = useCallback(() => {
    const r = rec.current;
    if (r && r.state !== 'inactive') {
      r.onstop = null;
      r.stop();
    }
    chunks.current = [];
    teardown();
    setS('idle');
    setElapsed(0);
    setLevel(0);
    setQuiet(false);
  }, [teardown]);

  const reset = useCallback(() => setResult(null), []);

  useEffect(() => () => {
    const r = rec.current;
    if (r && r.state !== 'inactive') {
      r.onstop = null;
      r.stop();
    }
    teardown();
  }, [teardown]);

  return { state, elapsed, level, quiet, error, result, start, pause, resume, stop, cancel, reset };
}

interface Props {
  prompt?: string;
  maxSeconds?: number;
  onRecorded: (r: RecordingResult | null) => void;
}

export function RecorderPanel({ prompt, maxSeconds = 30 * 60, onRecorded }: Props) {
  const r = useRecorder(maxSeconds);
  const url = useMemo(() => (r.result ? URL.createObjectURL(r.result.blob) : null), [r.result]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const notified = useRef<RecordingResult | null>(null);
  useEffect(() => {
    if (r.result !== notified.current) {
      notified.current = r.result;
      onRecorded(r.result);
    }
  }, [r.result, onRecorded]);

  if (!isSecureForMic()) {
    return (
      <div className="recorder-container">
        <h3>Recording needs a secure connection</h3>
        <p className="muted" style={{ margin: '12px 0 20px' }}>
          Browsers only allow microphone access on <strong>https://</strong> addresses (or on the NAS itself). You’re
          on a plain <code>http://</code> address, so the record button can’t work yet.
        </p>
        <div className="banner banner-info" style={{ textAlign: 'left' }}>
          <strong>Two easy options</strong>
          1) Record a voice memo on your phone and upload it. 2) Ask whoever set up Memento to turn on HTTPS (see Help → “Turn on HTTPS”).
        </div>
        <Link className="btn btn-primary" to="/add">Upload a recording instead</Link>
      </div>
    );
  }

  if (r.result && url) {
    return (
      <div className="recorder-container">
        <h3>Listen back</h3>
        <p className="muted">{formatDuration(r.result.duration)} recorded. Happy with it?</p>
        <audio className="review-audio" controls src={url} />
        <div className="recorder-controls">
          <button type="button" className="btn btn-outline" onClick={() => r.reset()}>Record again</button>
        </div>
      </div>
    );
  }

  const active = r.state !== 'idle';
  const bars = Array.from({ length: 28 }, (_, i) => {
    const wobble = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + r.elapsed * 3));
    return r.state === 'recording' ? Math.max(8, r.level * 100 * wobble) : 8;
  });

  return (
    <div className="recorder-container">
      {prompt && <p className="prompt-text" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)', marginBottom: 24 }}>“{prompt}”</p>}
      {active && (
        <>
          <div className="recorder-status">
            <span className={`recorder-status-dot ${r.state === 'recording' ? 'recording' : ''}`} />
            {r.state === 'recording' ? 'Recording…' : 'Paused'}
          </div>
          <div className="recorder-visualizer" aria-hidden="true">
            {bars.map((h, i) => <div key={i} className="visualizer-bar" style={{ height: `${h}%` }} />)}
          </div>
          <div className="recorder-timer" aria-live="off">{formatDuration(r.elapsed)}</div>
          {r.quiet && <div className="banner banner-info" role="status">Still there? Take your time. Tap pause if you need a moment.</div>}
          <div className="recorder-controls">
            <button type="button" className="btn btn-ghost btn-icon" onClick={r.cancel} aria-label="Cancel and discard"><X /></button>
            {r.state === 'recording' ? (
              <button type="button" className="btn btn-outline btn-large" onClick={r.pause}><Pause /> Pause</button>
            ) : (
              <button type="button" className="btn btn-outline btn-large" onClick={r.resume}><Play /> Resume</button>
            )}
            <button type="button" className="btn btn-primary btn-large" onClick={() => void r.stop()}><Square size={20} fill="currentColor" /> Finish</button>
          </div>
        </>
      )}
      {!active && (
        <>
          <button type="button" className="recorder-button big" onClick={() => void r.start()} aria-label="Start recording"><Mic size={48} /></button>
          <p style={{ fontSize: 'var(--text-lg)' }}>Tap to start recording</p>
          <p className="hint">Take your time. You can pause whenever you like.</p>
        </>
      )}
      {r.error && <div className="banner banner-error" role="alert" style={{ marginTop: 16, textAlign: 'left' }}>{r.error}</div>}
    </div>
  );
}
