/**
 * Loading placeholders (shimmer), shaped like the content they stand in for —
 * VS Code-style rows for lists and trees, lines for text. Purely visual:
 * screen readers get one polite "Loading…" via role="status".
 */
export function SkeletonRows({ rows = 6, icon = true, indent = false, label = "Loading" }: { rows?: number; icon?: boolean; indent?: boolean; label?: string }) {
  return (
    <div className="tm-skeleton-list" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="tm-skeleton-row" style={{ paddingLeft: indent ? 8 + (i % 3) * 12 : 20 }}>
          {icon && <span className="tm-skeleton tm-skeleton-icon" />}
          <span className="tm-skeleton tm-skeleton-line" style={{ width: `${45 + ((i * 37) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonLines({ lines = 4, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div className="tm-skeleton-text" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="tm-skeleton tm-skeleton-line" style={{ width: i === lines - 1 ? "55%" : `${88 - ((i * 13) % 20)}%` }} />
      ))}
    </div>
  );
}

/** A card-shaped placeholder (marketplace items, previews). */
export function SkeletonCard() {
  return (
    <div className="tm-skeleton-card" aria-hidden>
      <span className="tm-skeleton tm-skeleton-avatar" />
      <div className="tm-skeleton-card-body">
        <span className="tm-skeleton tm-skeleton-line" style={{ width: "50%" }} />
        <span className="tm-skeleton tm-skeleton-line" style={{ width: "85%" }} />
        <span className="tm-skeleton tm-skeleton-line" style={{ width: "30%" }} />
      </div>
    </div>
  );
}
