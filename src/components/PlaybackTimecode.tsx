import { useEffect, useState } from "react";
import type { PlaybackClock } from "../playback/usePlayback";
import { formatTime } from "../types";

interface Props {
  clock: PlaybackClock;
  durationMs: number;
}

const UPDATE_INTERVAL_MS = 80;

export function PlaybackTimecode({ clock, durationMs }: Props) {
  if (import.meta.env.DEV) console.count("[render] PlaybackTimecode");
  const [displayMs, setDisplayMs] = useState(() => clock.getPlayheadMs());

  useEffect(() => {
    let lastUpdate = 0;
    return clock.subscribe((playheadMs) => {
      const now = performance.now();
      if (now - lastUpdate < UPDATE_INTERVAL_MS && playheadMs < durationMs) return;
      lastUpdate = now;
      setDisplayMs(playheadMs);
    });
  }, [clock, durationMs]);

  return (
    <div className="time">
      <span className="time-now">{formatTime(displayMs)}</span>
      <span className="time-sep">/</span>
      <span className="time-total">{formatTime(durationMs)}</span>
    </div>
  );
}
