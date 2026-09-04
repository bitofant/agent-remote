import { describe, expect, it } from "vitest";
import {
  containerForPort,
  MAX_CONTAINERS,
  mergeContainers,
  parsePorts,
  parsePsLines,
  parseSize,
  parseStatsLines,
} from "./docker.js";

// Captured verbatim from the real host.
const PS_OUT = [
  "01bf1c2acf46\tminimax-h3-comfyui\tminimax-h3-comfyui:latest\trunning\tUp 3 minutes\t0.0.0.0:8190->8188/tcp, [::]:8190->8188/tcp",
  "18b215a7031c\topenclaw-openclaw-gateway-1\t47873f1247c6\trunning\tUp 3 days (healthy)\t0.0.0.0:3978->3978/tcp, [::]:3978->3978/tcp, 0.0.0.0:18789-18790->18789-18790/tcp, [::]:18789-18790->18789-18790/tcp",
  "4af5ef4ef47c\towui\tghcr.io/open-webui/open-webui:main\trunning\tUp 3 days (healthy)\t0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp",
  "aaf90b839d58\twebserver_nginx\tnginx:alpine\trunning\tUp 3 days\t0.0.0.0:80->80/tcp, [::]:80->80/tcp",
].join("\n");

const STATS_OUT = [
  "01bf1c2acf46\t0.01%\t635.7MiB / 91.96GiB\t859kB / 95.2MB",
  "18b215a7031c\t0.07%\t689.5MiB / 91.96GiB\t30MB / 14.7MB",
  "aaf90b839d58\t0.00%\t30.64MiB / 91.96GiB\t380MB / 393MB",
].join("\n");

describe("parsePsLines", () => {
  it("parses the real listing", () => {
    const rows = parsePsLines(PS_OUT);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatchObject({
      id: "4af5ef4ef47c",
      name: "owui",
      image: "ghcr.io/open-webui/open-webui:main",
      state: "running",
      status: "Up 3 days (healthy)",
    });
  });

  it("keeps a Status containing spaces and parentheses intact", () => {
    expect(parsePsLines(PS_OUT)[1].status).toBe("Up 3 days (healthy)");
  });

  it("handles a container with no published ports", () => {
    const row = parsePsLines("abc\tquiet\timg\trunning\tUp 1 min\t")[0];
    expect(row.ports).toEqual([]);
  });

  it("ignores blank lines and short rows", () => {
    expect(parsePsLines("\n\nbroken\trow\n")).toEqual([]);
  });

  it("caps the list", () => {
    const many = Array.from(
      { length: MAX_CONTAINERS + 10 },
      (_, i) => `id${i}\tname${i}\timg\trunning\tUp\t`,
    ).join("\n");
    expect(parsePsLines(many)).toHaveLength(MAX_CONTAINERS);
  });
});

describe("parsePorts", () => {
  it("reads the host port from a normal mapping", () => {
    expect(parsePorts(["0.0.0.0:8080->8080/tcp", "[::]:8080->8080/tcp"])).toEqual([8080]);
  });

  it("reads a host port that differs from the container port", () => {
    expect(parsePorts(["0.0.0.0:8190->8188/tcp"])).toEqual([8190]);
  });

  it("expands a published range, so a match inside it isn't missed", () => {
    expect(parsePorts(["0.0.0.0:18789-18790->18789-18790/tcp"])).toEqual([
      18789, 18790,
    ]);
  });

  it("ignores an unpublished container port", () => {
    expect(parsePorts(["8188/tcp"])).toEqual([]);
  });

  it("accepts the raw comma-joined column too", () => {
    expect(parsePorts("0.0.0.0:80->80/tcp, [::]:443->443/tcp")).toEqual([80, 443]);
  });

  it("is empty for no ports", () => {
    expect(parsePorts([])).toEqual([]);
    expect(parsePorts("")).toEqual([]);
  });
});

describe("containerForPort", () => {
  const rows = parsePsLines(PS_OUT);

  it("finds the container publishing a port", () => {
    expect(containerForPort(rows, 8080)?.name).toBe("owui");
    expect(containerForPort(rows, 8190)?.name).toBe("minimax-h3-comfyui");
  });

  it("finds a port inside a published range", () => {
    expect(containerForPort(rows, 18790)?.name).toBe("openclaw-openclaw-gateway-1");
  });

  it("is null when nothing publishes that port", () => {
    expect(containerForPort(rows, 9999)).toBeNull();
  });

  it("does not match a container-side-only port", () => {
    // 8188 is only the container side of the 8190 mapping.
    expect(containerForPort(rows, 8188)).toBeNull();
  });
});

describe("parseSize", () => {
  it("parses binary units (MemUsage)", () => {
    expect(parseSize("635.7MiB")).toBeCloseTo(635.7 * 1024 ** 2, 0);
    expect(parseSize("91.96GiB")).toBeCloseTo(91.96 * 1024 ** 3, 0);
  });

  it("parses decimal units (NetIO), which docker mixes into the same line", () => {
    expect(parseSize("859kB")).toBeCloseTo(859e3, 6);
    expect(parseSize("95.2MB")).toBeCloseTo(95.2e6, 6);
  });

  it("parses a bare byte count", () => {
    expect(parseSize("0B")).toBe(0);
    expect(parseSize(" 512 ")).toBe(512);
  });

  it("is null for junk", () => {
    expect(parseSize("--")).toBeNull();
    expect(parseSize("")).toBeNull();
    expect(parseSize("12QB")).toBeNull();
  });
});

describe("parseStatsLines", () => {
  it("parses percentages and both halves of each pair", () => {
    const rows = parseStatsLines(STATS_OUT);
    expect(rows[0].cpuPct).toBeCloseTo(0.01, 6);
    expect(rows[0].memUsedBytes).toBeCloseTo(635.7 * 1024 ** 2, 0);
    expect(rows[0].memLimitBytes).toBeCloseTo(91.96 * 1024 ** 3, 0);
    expect(rows[0].netRxBytes).toBeCloseTo(859e3, 6);
    expect(rows[0].netTxBytes).toBeCloseTo(95.2e6, 6);
  });

  it("keeps a genuine zero", () => {
    expect(parseStatsLines(STATS_OUT)[2].cpuPct).toBe(0);
  });

  it("ignores blank and malformed lines", () => {
    expect(parseStatsLines("\nnope\n")).toEqual([]);
  });
});

describe("mergeContainers", () => {
  it("joins stats onto the listing by id", () => {
    const out = mergeContainers(parsePsLines(PS_OUT), parseStatsLines(STATS_OUT));
    expect(out).toHaveLength(4);
    expect(out[0].cpuPct).toBeCloseTo(0.01, 6);
  });

  it("still lists a container the stats pass missed, with null numbers", () => {
    const out = mergeContainers(parsePsLines(PS_OUT), parseStatsLines(STATS_OUT));
    const owui = out.find((c) => c.name === "owui");
    expect(owui).toBeDefined();
    expect(owui?.cpuPct).toBeNull();
    expect(owui?.memUsedBytes).toBeNull();
  });

  it("works with no stats at all (first tick, before the slow pass ran)", () => {
    const out = mergeContainers(parsePsLines(PS_OUT), []);
    expect(out).toHaveLength(4);
    expect(out.every((c) => c.cpuPct === null)).toBe(true);
  });
});
