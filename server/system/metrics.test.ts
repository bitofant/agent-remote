import { describe, expect, it } from "vitest";
import {
  flavourOf,
  labelOf,
  looksLikePrometheus,
  parsePrometheus,
  sumOf,
} from "./metrics.js";

// Trimmed from the real vLLM endpoint on this host.
const VLLM = `# HELP vllm:num_requests_running Number of requests in model execution batches.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 1.0
# HELP vllm:num_requests_waiting Number of requests waiting to be processed.
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 0.0
# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 0.0798685
# TYPE vllm:generation_tokens_total counter
vllm:generation_tokens_total{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 89950.0
# TYPE vllm:request_success_total counter
vllm:request_success_total{engine="0",finished_reason="stop",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 160.0
vllm:request_success_total{engine="0",finished_reason="length",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 4.0
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_sum{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 42.5
vllm:time_to_first_token_seconds_count{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 164.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 164.0
python_gc_objects_collected_total{generation="0"} 12345.0`;

const LLAMACPP = `# HELP llamacpp:requests_processing Number of requests processing.
# TYPE llamacpp:requests_processing gauge
llamacpp:requests_processing 2
# TYPE llamacpp:kv_cache_usage_ratio gauge
llamacpp:kv_cache_usage_ratio 0.35
# TYPE llamacpp:tokens_predicted_total counter
llamacpp:tokens_predicted_total 55123`;

// Open-WebUI serves this from /metrics with HTTP 200 — the false positive
// that content validation exists to catch.
const SPA_HTML = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
	</head>
</html>`;

describe("parsePrometheus", () => {
  it("skips HELP/TYPE comments and reads samples", () => {
    const s = parsePrometheus(VLLM);
    expect(s.some((x) => x.name.startsWith("#"))).toBe(false);
    expect(s.find((x) => x.name === "vllm:num_requests_running")?.value).toBe(1);
  });

  it("parses labels containing commas, slashes and dashes", () => {
    const s = parsePrometheus(VLLM);
    const run = s.find((x) => x.name === "vllm:num_requests_running");
    expect(run?.labels).toEqual({
      engine: "0",
      model_name: "RedHatAI/gemma-4-31B-it-NVFP4",
    });
  });

  it("parses an unlabelled sample (llama.cpp style)", () => {
    const s = parsePrometheus(LLAMACPP);
    expect(s.find((x) => x.name === "llamacpp:requests_processing")).toMatchObject({
      labels: {},
      value: 2,
    });
  });

  it("handles an escaped quote inside a label value", () => {
    const s = parsePrometheus('m{note="a \\"quoted\\" bit",b="2"} 7');
    expect(s[0].labels.note).toBe('a "quoted" bit');
    expect(s[0].labels.b).toBe("2");
    expect(s[0].value).toBe(7);
  });

  it("reads +Inf and drops NaN samples", () => {
    const s = parsePrometheus('h_bucket{le="+Inf"} +Inf\nbad_metric NaN');
    expect(s).toHaveLength(1);
    expect(s[0].value).toBe(Number.POSITIVE_INFINITY);
  });

  it("ignores a trailing exemplar and timestamp", () => {
    const s = parsePrometheus('m_total{a="1"} 5 # {trace_id="abc"} 1.0 1700000000');
    expect(s[0].value).toBe(5);
  });

  it("returns nothing for HTML or empty input", () => {
    expect(parsePrometheus(SPA_HTML).length).toBe(0);
    expect(parsePrometheus("")).toEqual([]);
  });
});

describe("sumOf", () => {
  it("sums across label sets", () => {
    // 160 "stop" + 4 "length".
    expect(sumOf(parsePrometheus(VLLM), "vllm:request_success_total")).toBe(164);
  });

  it("reads a single-sample metric", () => {
    expect(sumOf(parsePrometheus(VLLM), "vllm:generation_tokens_total")).toBe(89950);
  });

  it("is null (not 0) for an absent metric", () => {
    // "no such metric" must not read as "zero requests waiting".
    expect(sumOf(parsePrometheus(VLLM), "vllm:nonexistent")).toBeNull();
  });

  it("keeps a genuine zero", () => {
    expect(sumOf(parsePrometheus(VLLM), "vllm:num_requests_waiting")).toBe(0);
  });

  it("skips non-finite samples", () => {
    const s = parsePrometheus('h_bucket{le="+Inf"} +Inf');
    expect(sumOf(s, "h_bucket")).toBeNull();
  });
});

describe("labelOf", () => {
  it("reads the model name off any tagged sample", () => {
    expect(
      labelOf(parsePrometheus(VLLM), "vllm:num_requests_running", "model_name"),
    ).toBe("RedHatAI/gemma-4-31B-it-NVFP4");
  });

  it("is null when the metric or label is absent", () => {
    expect(labelOf(parsePrometheus(VLLM), "vllm:nope", "model_name")).toBeNull();
    expect(labelOf(parsePrometheus(LLAMACPP), "llamacpp:requests_processing", "x")).toBeNull();
  });
});

describe("looksLikePrometheus", () => {
  it("accepts real exposition text", () => {
    expect(looksLikePrometheus(VLLM, "text/plain; version=0.0.4")).toBe(true);
    expect(looksLikePrometheus(LLAMACPP)).toBe(true);
  });

  it("rejects an SPA that answers 200 with HTML", () => {
    expect(looksLikePrometheus(SPA_HTML, "text/html; charset=utf-8")).toBe(false);
    // Even without the content-type header, the body gives it away.
    expect(looksLikePrometheus(SPA_HTML)).toBe(false);
  });

  it("rejects an html content-type even when the body looks plausible", () => {
    expect(looksLikePrometheus(VLLM, "text/html")).toBe(false);
  });

  it("rejects an empty body and JSON", () => {
    expect(looksLikePrometheus("")).toBe(false);
    expect(looksLikePrometheus('{"status":true}')).toBe(false);
  });

  it("rejects comments with no samples", () => {
    expect(looksLikePrometheus("# HELP a thing\n# TYPE a gauge")).toBe(false);
  });
});

describe("flavourOf", () => {
  it("identifies each engine by its metric prefix", () => {
    expect(flavourOf(VLLM)).toBe("vllm");
    expect(flavourOf(LLAMACPP)).toBe("llamacpp");
  });

  it("is unknown for some other exporter", () => {
    expect(flavourOf("# TYPE go_goroutines gauge\ngo_goroutines 12")).toBe("unknown");
    expect(flavourOf(SPA_HTML)).toBe("unknown");
  });
});
