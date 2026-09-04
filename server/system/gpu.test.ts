import { describe, expect, it } from "vitest";
import {
  containerFromCgroup,
  MAX_GPU_PROCESSES,
  num,
  parseComputeApps,
  parseGpuCsv,
} from "./gpu.js";

describe("parseGpuCsv", () => {
  // Captured from the real host: RTX 5090, driver 610.43.02.
  const REAL =
    "0, NVIDIA GeForce RTX 5090, 0, 23, 540, 32607, 32, 15.92, 600.00, 0, 225, 405, 610.43.02, 58, 3135, 14001";

  it("maps every field of a real nvidia-smi row", () => {
    const { gpus, driverVersion } = parseGpuCsv(REAL);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({
      index: 0,
      name: "NVIDIA GeForce RTX 5090",
      utilizationPct: 0,
      memoryUtilPct: 23,
      memoryUsedMb: 540,
      memoryTotalMb: 32607,
      tempC: 32,
      powerWatts: 15.92,
      powerLimitWatts: 600,
      fanPct: 0,
      clockSmMhz: 225,
      clockMemMhz: 405,
      clockSmMaxMhz: 3135,
      clockMemMaxMhz: 14001,
    });
    expect(driverVersion).toBe("610.43.02");
  });

  it("treats temperature.gpu.tlimit as a MARGIN, not an absolute limit", () => {
    // nvidia-smi -q calls this "GPU Current T.Limit Temp": headroom in °C.
    // 32°C now + 58°C of headroom = throttles at 90°C. Reading 58 as the
    // ceiling would paint an idle card as dangerously hot.
    expect(parseGpuCsv(REAL).gpus[0].tempLimitC).toBe(90);
  });

  it("has no temp limit when the driver omits tlimit", () => {
    const older =
      "0, NVIDIA T4, 10, 5, 100, 15360, 40, 30.00, 70.00, 20, 585, 5000, 470.82, [N/A], [N/A], [N/A]";
    const g = parseGpuCsv(older).gpus[0];
    expect(g.tempC).toBe(40);
    expect(g.tempLimitC).toBeNull();
    expect(g.clockSmMaxMhz).toBeNull();
  });

  it("reads several GPUs", () => {
    const two = `${REAL}\n1, NVIDIA A100, 55, 40, 1000, 40960, 61, 250.00, 300.00, 30, 1400, 1200, 610.43.02, 20, 1410, 1215`;
    const { gpus } = parseGpuCsv(two);
    expect(gpus.map((g) => g.index)).toEqual([0, 1]);
    expect(gpus[1].name).toBe("NVIDIA A100");
    expect(gpus[1].tempLimitC).toBe(81);
  });

  it("turns [N/A] and [Not Supported] into null, never 0", () => {
    const na =
      "0, NVIDIA T4, [N/A], [N/A], 100, 15360, 40, [Not Supported], [Not Supported], [N/A], 585, 5000, 550.54, [N/A], [N/A], [N/A]";
    const { gpus } = parseGpuCsv(na);
    expect(gpus[0].utilizationPct).toBeNull();
    expect(gpus[0].powerWatts).toBeNull();
    expect(gpus[0].fanPct).toBeNull();
    // A real reading alongside them still comes through.
    expect(gpus[0].memoryUsedMb).toBe(100);
  });

  it("ignores blank lines and trailing whitespace", () => {
    const { gpus } = parseGpuCsv(`\n  ${REAL}  \n\n`);
    expect(gpus).toHaveLength(1);
  });

  it("returns nothing for empty output rather than a bogus row", () => {
    expect(parseGpuCsv("").gpus).toEqual([]);
    expect(parseGpuCsv("").driverVersion).toBeNull();
  });
});

describe("num", () => {
  it("rejects the placeholder strings nvidia-smi uses", () => {
    expect(num("[N/A]")).toBeNull();
    expect(num("N/A")).toBeNull();
    expect(num("[Not Supported]")).toBeNull();
    expect(num("")).toBeNull();
    expect(num(undefined)).toBeNull();
  });

  it("keeps a genuine zero", () => {
    expect(num("0")).toBe(0);
  });
});

describe("parseComputeApps", () => {
  it("parses the real vLLM engine row", () => {
    const out = parseComputeApps("624869, VLLM::EngineCore, 31958");
    expect(out).toEqual([
      { pid: 624869, name: "VLLM::EngineCore", usedMemoryMb: 31958, container: null },
    ]);
  });

  it("treats empty output as an idle GPU, not an error", () => {
    expect(parseComputeApps("")).toEqual([]);
    expect(parseComputeApps("\n  \n")).toEqual([]);
  });

  it("skips rows with an unparseable pid", () => {
    expect(parseComputeApps("notapid, x, 10")).toEqual([]);
  });

  it("caps the list so a busy host can't bloat every poll", () => {
    const many = Array.from(
      { length: MAX_GPU_PROCESSES + 20 },
      (_, i) => `${i + 1}, proc${i}, 10`,
    ).join("\n");
    expect(parseComputeApps(many)).toHaveLength(MAX_GPU_PROCESSES);
  });
});

describe("containerFromCgroup", () => {
  it("extracts the id from a real cgroup v2 scope line", () => {
    const line =
      "0::/system.slice/docker-01bf1c2acf461b6f7a718236fe76b691822dcb2735247c03049438380e81e7b4.scope";
    expect(containerFromCgroup(line)).toBe(
      "01bf1c2acf461b6f7a718236fe76b691822dcb2735247c03049438380e81e7b4",
    );
  });

  it("extracts the id from a cgroup v1 docker path", () => {
    const v1 =
      "11:devices:/docker/9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1908070605040302010009080706\n10:memory:/docker/9f8e7d6c5b4a";
    expect(containerFromCgroup(v1)).toBe(
      "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1908070605040302010009080706",
    );
  });

  it("is null for a plain host process", () => {
    expect(containerFromCgroup("0::/user.slice/user-1000.slice/session-3.scope")).toBeNull();
  });

  it("is null for runtimes whose ids don't join to `docker ps`", () => {
    expect(
      containerFromCgroup(
        "0::/kubepods.slice/kubepods-besteffort.slice/cri-containerd-abc123def456.scope",
      ),
    ).toBeNull();
    expect(containerFromCgroup("0::/machine.slice/libpod-abc123def456.scope")).toBeNull();
  });

  it("is null for unreadable/empty input", () => {
    expect(containerFromCgroup("")).toBeNull();
  });
});
