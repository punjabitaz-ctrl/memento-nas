import { useNavigate } from 'react-router-dom';
import type { LightMemory, Memory } from '../types';
import { TYPE_ICON, TYPE_LABEL, formatMemoryDate } from '../util';

export function toLight(m: Memory): LightMemory {
  return {
    id: m.id, type: m.type, title: m.title, summary: m.aiSummary || m.description || m.content.slice(0, 200),
    memoryDate: m.memoryDate, datePrecision: m.datePrecision, privacy: m.privacy,
    contributor: m.contributor,
    thumb: m.media.find((x) => x.kind === 'image')?.url ?? null,
    mediaKinds: [...new Set(m.media.map((x) => x.kind))],
  };
}

export function MemoryCard({ m, snippet }: { m: LightMemory; snippet?: React.ReactNode }) {
  const nav = useNavigate();
  const go = () => nav(`/memory/${m.id}`);
  return (
    <article
      className="memory-card"
      role="link"
      tabIndex={0}
      aria-label={`${m.title || TYPE_LABEL[m.type]}, ${formatMemoryDate(m.memoryDate, m.datePrecision)}`}
      onClick={go}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }}
    >
      <div className="memory-card-media">
        {m.thumb ? <img src={m.thumb} alt="" loading="lazy" /> : <span className="type-big" aria-hidden="true">{TYPE_ICON[m.type]}</span>}
      </div>
      <div className="memory-card-content">
        <div className="memory-card-date">{formatMemoryDate(m.memoryDate, m.datePrecision)}</div>
        <h4 className="memory-card-title">{m.title || TYPE_LABEL[m.type]}</h4>
        <p className="memory-card-excerpt">{snippet ?? m.summary}</p>
        <div className="memory-card-footer">
          <span className="memory-card-contributor">
            <span className="contributor-avatar" aria-hidden="true">{m.contributor.displayName.charAt(0).toUpperCase()}</span>
            {m.contributor.displayName}
          </span>
          <span className="privacy-pill">{m.privacy === 'private' ? '🔒 Just me' : TYPE_LABEL[m.type]}</span>
        </div>
      </div>
    </article>
  );
}
