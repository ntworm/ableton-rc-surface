/**
 * CPU usage sampling for the Connect tab server-CPU bar (v0.4.20+).
 *
 * Public API:
 *   sampleCpuUsagePercent(): number   // returns [0, 1]
 *   resetCpuUsageSampleForTest(): void  // resets internal deltas
 *
 * Implementation: capture total + idle CPU ticks across calls via os.cpus()
 * and compute the delta between samples. Normalized by logical core count
 * (clamp at 1.0). On a single-core machine, 100% busy is 1.0.
 *
 * The first call after reset returns 0 because no delta exists; callers
 * should let the loop tick once and read on subsequent calls.
 */
import { cpus } from "node:os";

interface CpuSample {
  idle: number;
  total: number;
  at: number;  // ms timestamp (informational only, not used for math)
}

let lastSample: CpuSample | null = null;

function snapshot(): CpuSample {
  const cpusInfo = cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpusInfo) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total, at: Date.now() };
}

export function resetCpuUsageSampleForTest(): void {
  lastSample = null;
}

/**
 * Returns fractional CPU usage in [0, 1].
 *
 * First call after reset returns 0 (no delta available).
 * Subsequent calls return the busy-fraction delta since the previous call,
 * normalized by the logical core count, and clamped to [0, 1].
 */
export function sampleCpuUsagePercent(): number {
  const cur = snapshot();
  if (lastSample === null) {
    lastSample = cur;
    return 0;
  }
  const prev = lastSample;
  lastSample = cur;

  const deltaTotal = cur.total - prev.total;
  const deltaIdle = cur.idle - prev.idle;
  if (deltaTotal <= 0) return 0;

  const cores = Math.max(1, cpus().length);
  const busyFraction = 1 - deltaIdle / deltaTotal;
  // busyFraction is across all cores summed; divide by core count to get
  // an average per-core busy fraction in [0, 1].
  const perCore = busyFraction / cores;
  // Clamp: a noisy single-tick sample can occasionally exceed 1 due to
  // tick count rounding; the public contract is [0, 1].
  if (!Number.isFinite(perCore)) return 0;
  if (perCore <= 0) return 0;
  if (perCore >= 1) return 1;
  return perCore;
}
