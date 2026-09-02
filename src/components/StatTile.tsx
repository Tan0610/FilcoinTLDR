import type { ReactNode } from "react";

export interface StatTileProps {
  label: string;
  value: string;
  unit?: string;
  sub?: ReactNode;
  accent?: string;
  emphasis?: boolean;
  /**
   * Full-precision text shown on hover. Defaults to `value`. Use it whenever
   * the displayed figure has been shortened or re-based, so the exact reading
   * is never lost — only made readable.
   */
  title?: string;
}

export function StatTile({
  label,
  value,
  unit,
  sub,
  accent,
  emphasis,
  title,
}: StatTileProps) {
  return (
    // min-w-0 on the tile and on the value row: without it a grid item's
    // automatic minimum is its content, so a long figure widens the tile and
    // spills under its neighbour instead of being clipped inside its own box.
    <div className="flex min-w-0 flex-col justify-between border border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-2 text-[10px] tracking-[0.26em] text-ink-dim">
        {accent && (
          <span className="inline-block h-2 w-2 shrink-0" style={{ background: accent }} />
        )}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 flex min-w-0 items-baseline gap-1.5" title={title ?? value}>
        <span
          className={`tnum min-w-0 truncate font-bold leading-none ${
            emphasis ? "text-[clamp(1.6rem,2.6vw,2.2rem)]" : "text-[clamp(1.25rem,2vw,1.7rem)]"
          }`}
          style={accent ? { color: accent } : undefined}
        >
          {value}
        </span>
        {unit && <span className="shrink-0 text-[11px] text-ink-dim">{unit}</span>}
      </div>
      {sub && <div className="mt-1.5 truncate text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}
