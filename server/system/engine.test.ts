import { describe, expect, it } from "vitest";
import { parsePrometheus } from "./metrics.js";
import {
  normalizeMetrics,
  parseEngineTarget,
  parseModelsBody,
  parsePropsBody,
} from "./engine.js";

describe("parseEngineTarget", () => {
  it("strips the /v1 prefix so /metrics resolves at the server root", () => {
    const t = parseEngineTarget("http://localhost:8000/v1");
    expect(t).toMatchObject({
      origin: "http://localhost:8000",
      port: 8000,
      isLocal: true,
      metricsUrl: "http://localhost:8000/metrics",
      modelsUrl: "http://localhost:8000/v1/models",
      propsUrl: "http://localhost:8000/props",
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parseEngineTarget("http://localhost:8000/v1/")?.metricsUrl).toBe(
      "http://localhost:8000/metrics",
    );
  });

  it("accepts a bare origin with no /v1", () => {
    expect(parseEngineTarget("http://localhost:8000")?.metricsUrl).toBe(
      "http://localhost:8000/metrics",
    );
  });

  it("treats loopback addresses as local", () => {
    expect(parseEngineTarget("http://127.0.0.1:8000/v1")?.isLocal).toBe(true);
    expect(parseEngineTarget("http://127.1.2.3:9000/v1")?.isLocal).toBe(true);
    expect(parseEngineTarget("http://[::1]:8000/v1")?.isLocal).toBe(true);
  });

  it("treats a remote endpoint as not local (so we report no local engine)", () => {
    const t = parseEngineTarget("https://api.example.com/v1");
    expect(t?.isLocal).toBe(false);
    expect(t?.port).toBe(443);
  });

  it("defaults the port by scheme", () => {
    expect(parseEngineTarget("http://localhost/v1")?.port).toBe(80);
  });

  it("is null for junk and non-http schemes", () => {
    expect(parseEngineTarget("")).toBeNull();
    expect(parseEngineTarget("not a url")).toBeNull();
    expect(parseEngineTarget("file:///etc/passwd")).toBeNull();
  });
});

const VLLM = `# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 1.0
vllm:num_requests_waiting{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 3.0
vllm:kv_cache_usage_perc{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 0.25
vllm:prompt_tokens_total{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 841281.0
vllm:generation_tokens_total{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 89950.0
vllm:prefix_cache_queries_total{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 1000.0
vllm:prefix_cache_hits_total{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 750.0
vllm:num_preemptions_total{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 0.0
vllm:time_to_first_token_seconds_sum{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 42.5
vllm:time_to_first_token_seconds_count{engine="0",model_name="RedHatAI/gemma-4-31B-it-NVFP4"} 164.0`;

const LLAMACPP = `# TYPE llamacpp:requests_processing gauge
llamacpp:requests_processing 2
llamacpp:requests_deferred 1
llamacpp:kv_cache_usage_ratio 0.35
llamacpp:prompt_tokens_total 12345
llamacpp:tokens_predicted_total 55123`;

describe("normalizeMetrics", () => {
  it("maps vLLM metrics onto the normalized shape", () => {
    const { gauges, counters, model } = normalizeMetrics(
      "vllm",
      parsePrometheus(VLLM),
      1000,
    );
    expect(gauges.requestsRunning).toBe(1);
    expect(gauges.requestsWaiting).toBe(3);
    expect(gauges.kvCacheUsedPct).toBeCloseTo(25, 6);
    expect(gauges.prefixCacheHitPct).toBeCloseTo(75, 6);
    expect(gauges.preemptionsTotal).toBe(0);
    expect(counters.generationTokens).toBe(89950);
    expect(counters.ttftCount).toBe(164);
    expect(model).toBe("RedHatAI/gemma-4-31B-it-NVFP4");
  });

  it("maps llama.cpp metrics onto the SAME keys", () => {
    const { gauges, counters } = normalizeMetrics(
      "llamacpp",
      parsePrometheus(LLAMACPP),
      1000,
    );
    expect(gauges.requestsRunning).toBe(2);
    expect(gauges.requestsWaiting).toBe(1);
    expect(gauges.kvCacheUsedPct).toBeCloseTo(35, 6);
    expect(gauges.promptTokensTotal).toBe(12345);
    expect(counters.generationTokens).toBe(55123);
  });

  it("nulls the metrics a flavour doesn't have, rather than reporting 0", () => {
    const { gauges, counters } = normalizeMetrics(
      "llamacpp",
      parsePrometheus(LLAMACPP),
      1000,
    );
    expect(gauges.prefixCacheHitPct).toBeNull();
    expect(gauges.preemptionsTotal).toBeNull();
    expect(counters.ttftSum).toBeNull();
  });

  it("yields all-null for an unknown exporter", () => {
    const { gauges, model } = normalizeMetrics("unknown", parsePrometheus(VLLM), 1);
    expect(Object.values(gauges).every((v) => v === null)).toBe(true);
    expect(model).toBeNull();
  });

  it("degrades to null when a metric has been renamed upstream", () => {
    const renamed = "vllm:num_requests_in_flight{engine=\"0\"} 5";
    const { gauges } = normalizeMetrics("vllm", parsePrometheus(renamed), 1);
    expect(gauges.requestsRunning).toBeNull();
  });

  it("cannot divide by zero on the prefix-cache ratio", () => {
    const cold = `vllm:prefix_cache_queries_total{engine="0"} 0
vllm:prefix_cache_hits_total{engine="0"} 0`;
    const { gauges } = normalizeMetrics("vllm", parsePrometheus(cold), 1);
    expect(gauges.prefixCacheHitPct).toBeNull();
  });
});

describe("parseModelsBody", () => {
  it("reads the model id and context length", () => {
    const body = JSON.stringify({
      data: [{ id: "RedHatAI/gemma-4-31B-it-NVFP4", max_model_len: 105000 }],
    });
    expect(parseModelsBody(body)).toEqual({
      model: "RedHatAI/gemma-4-31B-it-NVFP4",
      maxModelLen: 105000,
    });
  });

  it("tolerates a missing max_model_len", () => {
    expect(parseModelsBody('{"data":[{"id":"m"}]}')).toEqual({
      model: "m",
      maxModelLen: null,
    });
  });

  it("rejects an SPA's HTML — the parse is the content validation", () => {
    expect(parseModelsBody("<!doctype html><html></html>")).toBeNull();
  });

  it("rejects well-formed JSON that isn't a model list", () => {
    expect(parseModelsBody('{"status":true}')).toBeNull();
    expect(parseModelsBody('{"data":[]}')).toBeNull();
    expect(parseModelsBody('{"data":[{"id":123}]}')).toBeNull();
  });
});

describe("parsePropsBody", () => {
  it("reads n_ctx and the model from llama.cpp /props", () => {
    const body = JSON.stringify({
      default_generation_settings: { n_ctx: 4096, model: "models/qwen.gguf" },
    });
    expect(parsePropsBody(body)).toEqual({
      model: "models/qwen.gguf",
      maxModelLen: 4096,
    });
  });

  it("falls back to top-level n_ctx / model_path", () => {
    expect(parsePropsBody('{"n_ctx":8192,"model_path":"/m.gguf"}')).toEqual({
      model: "/m.gguf",
      maxModelLen: 8192,
    });
  });

  it("rejects HTML", () => {
    expect(parsePropsBody("<!doctype html>")).toBeNull();
  });

  it("rejects JSON carrying no recognisable field", () => {
    // Otherwise any service answering JSON would read as a llama.cpp server.
    expect(parsePropsBody("{}")).toBeNull();
    expect(parsePropsBody('{"status":true}')).toBeNull();
  });
});
