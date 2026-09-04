// Prometheus text-format parsing for the LLM engine section. Pure — no I/O.
//
// Deliberately a small subset: samples with labels, summed across label sets.
// Engines emit label sets we must not assume away (vLLM tags every metric with
// {engine="0", model_name="..."}), so a lookup sums matching samples rather
// than reading "the" value.

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Prometheus escapes \\, \" and \n inside label values. */
function unescapeLabel(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c,
  );
}

function parseLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Values are quoted and may contain commas, slashes and escaped quotes, so
  // splitting on "," would corrupt them — match key="value" pairs instead.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1]] = unescapeLabel(m[2]);
  return out;
}

function parseValue(raw: string): number {
  const s = raw.trim();
  if (s === "+Inf") return Number.POSITIVE_INFINITY;
  if (s === "-Inf") return Number.NEGATIVE_INFINITY;
  return Number(s);
}

/** Index of the `}` closing the label set opened at `open`, ignoring braces
 * inside quoted values. `lastIndexOf` is wrong here: an exemplar carries its
 * own `{...}` after the value, and grabbing that brace swallows the value. */
function closingBrace(line: string, open: number): number {
  let quoted = false;
  for (let i = open + 1; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "}") return i;
  }
  return -1;
}

/** Comments (`# HELP` / `# TYPE`) are skipped; so is a trailing exemplar
 * (` # {trace_id="..."} 1 1234`), which is metadata, not a value. */
export function parsePrometheus(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const brace = line.indexOf("{");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    if (brace >= 0) {
      const close = closingBrace(line, brace);
      if (close < brace) continue;
      name = line.slice(0, brace).trim();
      labels = parseLabels(line.slice(brace + 1, close));
      rest = line.slice(close + 1);
    } else {
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp);
    }
    if (!name) continue;
    // Drop an exemplar, then take the value (a trailing timestamp is ignored).
    const value = parseValue(rest.split("#")[0].trim().split(/\s+/)[0] ?? "");
    if (Number.isNaN(value)) continue;
    out.push({ name, labels, value });
  }
  return out;
}

/** Sum of every sample with this name, across label sets. Null — never 0 —
 * when the metric is absent, so "this engine has no such metric" can't be
 * mistaken for "zero requests waiting". */
export function sumOf(samples: Sample[], name: string): number | null {
  let total: number | null = null;
  for (const s of samples) {
    if (s.name !== name) continue;
    if (!Number.isFinite(s.value)) continue;
    total = (total ?? 0) + s.value;
  }
  return total;
}

/** First label value found for a metric — used to read `model_name` off any
 * vLLM sample when /v1/models isn't reachable. */
export function labelOf(
  samples: Sample[],
  name: string,
  label: string,
): string | null {
  for (const s of samples) {
    if (s.name === name && s.labels[label]) return s.labels[label];
  }
  return null;
}

/** An HTML page returning 200 is the failure mode that matters here: an SPA on
 * the configured port (Open-WebUI serves index.html for /metrics AND /props)
 * would otherwise be reported as a running LLM engine. Validate the content. */
export function looksLikePrometheus(text: string, contentType?: string): boolean {
  if (contentType && /html/i.test(contentType)) return false;
  const body = text.trim();
  if (!body || body.startsWith("<")) return false;
  const hasComment = /^#\s*(HELP|TYPE)\s/m.test(body);
  const hasSample = parsePrometheus(body).length > 0;
  return hasComment && hasSample;
}

/** Which engine wrote these metrics, from the sample-name prefix. */
export function flavourOf(text: string): "vllm" | "llamacpp" | "unknown" {
  for (const s of parsePrometheus(text)) {
    if (s.name.startsWith("vllm:")) return "vllm";
    if (s.name.startsWith("llamacpp:")) return "llamacpp";
  }
  return "unknown";
}
