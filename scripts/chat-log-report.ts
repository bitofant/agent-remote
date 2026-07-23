// Diagnostic CLI for the chat render log (server/chatLog.ts + db.ts's
// chat_render_log): review how chat messages are displayed and spot rendering
// issues. Read-only. Reuses the same DB accessor as /api/chat-log, so the
// report reflects exactly what the UI shows.
//
//   npm run chat-log-report                     # summary + flagged issues
//   npm run chat-log-report -- --harness=claude # filter the corpus
//   npm run chat-log-report -- --dump=<msgId>   # full original + rendered JSON
//   npm run chat-log-report -- --issue=<name>   # every occurrence of an issue
//   npm run chat-log-report -- --tool=<name>    # arg previews for one tool
//   npm run chat-log-report -- --part=<type>    # sample rendered HTML for a type
//
// Common filters: --harness= --session= --limit=N --samples=N
// Add a new heuristic = add one entry to ISSUES below.

import type { ChatMessage, ChatPart } from "../shared/protocol.js";
import type { RenderedMessage } from "../shared/render.js";
import { argsPreview, renderMessage, toolView } from "../shared/render.js";
import { listChatRenderLog } from "../server/db.js";

const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const limit = Number(flag("limit") ?? 5000);
const samples = Number(flag("samples") ?? 3);
const harness = flag("harness");
const session = flag("session");

type Row = {
  sessionId: string;
  messageId: string;
  harnessId: string | null;
  role: string;
  original: ChatMessage;
  rendered: RenderedMessage;
};

let rows = listChatRenderLog(limit, session) as unknown as Row[];
if (harness) rows = rows.filter((r) => r.harnessId === harness);

if (rows.length === 0) {
  console.log("No chat render-log rows (after filters). Run some chat sessions first.");
  process.exit(0);
}

// ── Heuristic issue detectors. Each maps a part (+ its rendered form) to an
// optional one-line complaint; a null part is the whole message. Add one here
// instead of writing a throwaway script. ────────────────────────────────────
type Detector = (p: ChatPart | null, rp: RenderedMessage["parts"][number] | null, msg: Row) => string | null;
const ISSUES: Record<string, Detector> = {
  emptyRender: (p, _rp, m) =>
    p === null && (!m.rendered.html || !m.rendered.html.trim()) ? `${m.role} bubble renders empty` : null,
  emptyThinking: (p) =>
    p?.type === "thinking" && !p.text.trim() ? "thinking part has no text (collapses to nothing)" : null,
  emptyTextPart: (p) => (p?.type === "text" && !p.text.trim() ? "empty text part" : null),
  htmlInText: (p) =>
    p?.type === "text" && /<[a-z][\s\S]*?>/i.test(p.text) ? `raw HTML/angle-brackets: ${p.text.slice(0, 60)}` : null,
  longThinking: (p) => (p?.type === "thinking" && p.text.length > 4000 ? `${p.text.length} chars` : null),
  jsonArgsPreview: (p) =>
    // Flag on the actual displayed subject (toolView.primary), not raw
    // argsPreview — otherwise Bash/Edit/etc. false-positive despite rendering
    // fine, and the report can't confirm the tool-preview fix.
    p?.type === "tool" && toolView(p).primary.trimStart().startsWith("{") ? `${p.name}: preview is raw JSON` : null,
  emptyArgsPreview: (p) => (p?.type === "tool" && !argsPreview(p.args) ? `${p.name}: no preview` : null),
  toolNoOutput: (p) =>
    p?.type === "tool" && !p.output && (p.status === "done" || p.status === "error") ? `${p.name}: ${p.status}, no output` : null,
  longToolOutput: (p) => (p?.type === "tool" && (p.output?.length ?? 0) > 2000 ? `${p.name}: ${p.output!.length} chars` : null),
  errorTool: (p) => (p?.type === "tool" && p.status === "error" ? p.name : null),
};

const eachPart = (m: Row, fn: (p: ChatPart | null, rp: RenderedMessage["parts"][number] | null) => void) => {
  fn(null, null);
  m.original.parts.forEach((p, i) => fn(p, m.rendered.parts[i] ?? null));
};
const at = (m: Row) => `${m.harnessId ?? "?"}/${m.sessionId.slice(0, 8)} msg=${m.messageId.slice(0, 8)}`;

// ── Mode: dump one message's original + rendered JSON ────────────────────────
const dumpId = flag("dump");
if (dumpId) {
  const m = rows.find((r) => r.messageId === dumpId || r.messageId.startsWith(dumpId));
  if (!m) { console.log(`No message matching ${dumpId}`); process.exit(1); }
  console.log(`# ${at(m)}\n\n## original\n`);
  console.log(JSON.stringify(m.original, null, 2));
  console.log(`\n## rendered (stored)\n`);
  console.log(JSON.stringify(m.rendered, null, 2));
  // Re-render through the CURRENT renderer so this doubles as a way to verify
  // render.ts changes against real messages (stored rows use the old renderer).
  console.log(`\n## rendered (current renderer)\n`);
  console.log(JSON.stringify(renderMessage(m.original), null, 2));
  process.exit(0);
}

// ── Mode: every occurrence of one issue ──────────────────────────────────────
const issueName = flag("issue");
if (issueName) {
  const det = ISSUES[issueName];
  if (!det) { console.log(`Unknown issue. Known: ${Object.keys(ISSUES).join(", ")}`); process.exit(1); }
  let n = 0;
  for (const m of rows) eachPart(m, (p, rp) => { const d = det(p, rp, m); if (d) { n++; console.log(`${at(m)}  ${d}`); } });
  console.log(`\n${n} occurrence(s) of [${issueName}]`);
  process.exit(0);
}

// ── Mode: arg previews for one tool ──────────────────────────────────────────
const toolName = flag("tool");
if (toolName) {
  let n = 0;
  for (const m of rows) for (const p of m.original.parts) {
    if (p.type === "tool" && p.name === toolName) {
      if (n < 40) console.log(`${at(m)}  [${p.status}]  ${JSON.stringify(argsPreview(p.args)).slice(0, 120)}`);
      n++;
    }
  }
  console.log(`\n${n} call(s) to ${toolName}`);
  process.exit(0);
}

// ── Mode: sample rendered HTML for a part type ───────────────────────────────
const partType = flag("part");
if (partType) {
  let n = 0;
  // Re-render from the original through the current renderer (not the stored
  // HTML) so this reflects the code as it is now.
  for (const m of rows) for (const rp of renderMessage(m.original).parts) {
    if (rp.type === partType && n < samples) {
      console.log(`\n[${rp.type}] via ${rp.component} (${m.harnessId}) ${at(m)}`);
      console.log("  " + rp.html.replace(/\n/g, "\n  "));
      n++;
    }
  }
  process.exit(0);
}

// ── Default mode: summary + flagged issues ───────────────────────────────────
const tally = (get: (p: ChatPart, m: Row) => string | null) => {
  const m = new Map<string, number>();
  for (const row of rows) for (const p of row.original.parts) { const k = get(p, row); if (k != null) m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
};
const table = (m: Map<string, number>) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`).join("\n") || "  (none)";

console.log(`\n=== Chat render-log report (${rows.length} messages${harness ? `, harness=${harness}` : ""}) ===\n`);
console.log("Part types:\n" + table(tally((p) => p.type)) + "\n");
console.log("Render components:\n" + table(new Map(
  [...rows.flatMap((r) => r.rendered.parts.map((p) => p.component))].reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>()),
)) + "\n");
console.log("Tool names:\n" + table(tally((p) => (p.type === "tool" ? p.name : null))) + "\n");
console.log("Tool statuses:\n" + table(tally((p) => (p.type === "tool" ? p.status : null))) + "\n");

console.log("=== Flagged issues (see --issue=<name> for detail) ===");
const counts = new Map<string, string[]>();
for (const m of rows) eachPart(m, (p, rp) => {
  for (const [name, det] of Object.entries(ISSUES)) {
    const d = det(p, rp, m);
    if (d) { const arr = counts.get(name) ?? []; if (arr.length < 4) arr.push(`${at(m)}: ${d}`); counts.set(name, arr); }
  }
});
// Recount fully (samples above cap the shown list, not the count).
const fullCounts = new Map<string, number>();
for (const m of rows) eachPart(m, (p, rp) => {
  for (const [name, det] of Object.entries(ISSUES)) if (det(p, rp, m)) fullCounts.set(name, (fullCounts.get(name) ?? 0) + 1);
});
const flagged = [...fullCounts.entries()].sort((a, b) => b[1] - a[1]);
if (flagged.length === 0) console.log("  none\n");
for (const [name, count] of flagged) {
  console.log(`\n[${name}] ${count} occurrence(s)`);
  for (const s of counts.get(name) ?? []) console.log(`    - ${s}`);
}
