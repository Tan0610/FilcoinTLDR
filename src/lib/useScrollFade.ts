"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scroll affordance for an internally scrolling panel.
 *
 * A panel whose last row is sliced by a hard border reads as broken rather
 * than scrollable, so the caller paints a bottom fade whenever `showFade` is
 * true — i.e. only while there is genuinely more content below the fold.
 *
 * `dep` should be the item count: content growing inside a fixed-height
 * scroller does not resize the scroller, so the ResizeObserver alone would
 * miss it.
 */
export function useScrollFade<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const [showFade, setShowFade] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      setShowFade(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
    };

    update();
    el.addEventListener("scroll", update, { passive: true });

    const observer = new ResizeObserver(update);
    observer.observe(el);

    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [dep]);

  return { ref, showFade };
}

/** Inline style for the fade overlay, so both panels stay identical. */
export const SCROLL_FADE_STYLE = {
  background: "linear-gradient(to top, var(--panel) 20%, transparent)",
} as const;
