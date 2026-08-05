// Compact "time since" label for session/prompt lists (e.g. "3m", "2h", "5d").
// Shared by the resume picker (App.tsx) and the rewind picker (ChatView.tsx) —
// App lazy-imports ChatView, so it can't be the one exporting this.
export function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
