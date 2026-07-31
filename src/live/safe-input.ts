// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export type SafeInputState =
  | "idle"
  | "active"
  | "takeover"
  | "unstable"
  | "lost"
  | "predicting"
  | "decaying"
  | "recovering"
  | "disabled"
  | "error";

export type TakeoverMode = "scale" | "pickup" | "jump";

export interface LossPolicy {
  holdMs: number;
  releaseMs: number;
  neutralValue: number;
}

export interface SafeContinuousInputOptions {
  mode?: TakeoverMode;
  deadzone?: number;
  hysteresis?: number;
  loss?: Partial<LossPolicy>;
  recoveryAlpha?: number;
}

export interface SafeInputResult {
  value: number;
  state: SafeInputState;
  captured: boolean;
  hostValue: number;
  direction: -1 | 0 | 1;
}

export interface ProcessOptions {
  hostValue?: number;
  timestamp?: number;
  confidence?: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class SafeContinuousInput {
  readonly mode: TakeoverMode;
  readonly deadzone: number;
  readonly hysteresis: number;
  readonly loss: LossPolicy;
  readonly recoveryAlpha: number;

  private currentValue = 0;
  private currentHostValue = 0;
  private previousInput: number | null = null;
  private captured = false;
  private state: SafeInputState = "idle";
  private initialized = false;
  private lostAt: number | null = null;
  private lostFrom = 0;

  constructor(options: SafeContinuousInputOptions = {}) {
    this.mode = options.mode ?? "scale";
    this.deadzone = Math.max(0, options.deadzone ?? 0.02);
    this.hysteresis = Math.max(this.deadzone, options.hysteresis ?? 0.035);
    this.loss = {
      holdMs: Math.max(0, options.loss?.holdMs ?? 120),
      releaseMs: Math.max(1, options.loss?.releaseMs ?? 1200),
      neutralValue: clamp01(options.loss?.neutralValue ?? 0),
    };
    this.recoveryAlpha = clamp01(options.recoveryAlpha ?? 0.18);
  }

  matchesConfig(options: SafeContinuousInputOptions = {}): boolean {
    const mode = options.mode ?? "scale";
    const deadzone = Math.max(0, options.deadzone ?? 0.02);
    const hysteresis = Math.max(deadzone, options.hysteresis ?? 0.035);
    const holdMs = Math.max(0, options.loss?.holdMs ?? 120);
    const releaseMs = Math.max(1, options.loss?.releaseMs ?? 1200);
    const neutralValue = clamp01(options.loss?.neutralValue ?? 0);
    const recoveryAlpha = clamp01(options.recoveryAlpha ?? 0.18);
    return this.mode === mode
      && this.deadzone === deadzone
      && this.hysteresis === hysteresis
      && this.loss.holdMs === holdMs
      && this.loss.releaseMs === releaseMs
      && this.loss.neutralValue === neutralValue
      && this.recoveryAlpha === recoveryAlpha;
  }

  process(inputValue: number, options: ProcessOptions = {}): SafeInputResult {
    const timestamp = options.timestamp ?? Date.now();
    const input = clamp01(Number.isFinite(inputValue) ? inputValue : 0);
    const confidence = options.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0.2) {
      this.state = "unstable";
      return this.result(input);
    }

    if (this.lostAt !== null) {
      const start = this.currentValue;
      this.lostAt = null;
      this.previousInput = input;
      this.currentHostValue = start;
      this.currentValue = start + (input - start) * this.recoveryAlpha;
      this.captured = Math.abs(input - this.currentValue) <= this.deadzone;
      this.state = this.captured ? "active" : "recovering";
      this.initialized = true;
      return this.result(input);
    }

    if (!this.initialized) {
      const host = clamp01(options.hostValue ?? input);
      this.currentHostValue = host;
      this.previousInput = input;
      this.initialized = true;
      if (this.mode === "jump" || Math.abs(input - host) <= this.deadzone) {
        this.currentValue = input;
        this.currentHostValue = input;
        this.captured = true;
        this.state = "active";
      } else {
        this.currentValue = host;
        this.captured = false;
        this.state = "takeover";
      }
      return this.result(input);
    }

    if (options.hostValue !== undefined && Math.abs(options.hostValue - this.currentHostValue) > this.hysteresis) {
      this.reconcileHost(options.hostValue, timestamp);
    }

    const previous = this.previousInput ?? input;
    const crossedHost =
      (previous <= this.currentHostValue && input >= this.currentHostValue) ||
      (previous >= this.currentHostValue && input <= this.currentHostValue);

    if (this.mode === "jump") {
      this.currentValue = input;
      this.captured = true;
      this.state = "active";
    } else if (this.captured) {
      this.currentValue = input;
      this.currentHostValue = input;
      this.state = "active";
    } else if (crossedHost || Math.abs(input - this.currentValue) <= this.deadzone) {
      this.currentValue = input;
      this.currentHostValue = input;
      this.captured = true;
      this.state = "active";
    } else if (this.mode === "pickup") {
      this.currentValue = this.currentHostValue;
      this.state = "takeover";
    } else {
      const delta = input - previous;
      const availableInput = delta >= 0 ? Math.max(0.001, 1 - previous) : Math.max(0.001, previous);
      const availableOutput = delta >= 0 ? 1 - this.currentValue : this.currentValue;
      const scaledDelta = delta * (availableOutput / availableInput);
      this.currentValue = clamp01(this.currentValue + scaledDelta);
      this.currentHostValue = this.currentValue;
      if (Math.abs(input - this.currentValue) <= this.deadzone) {
        this.currentValue = input;
        this.captured = true;
        this.state = "active";
      } else {
        this.state = "takeover";
      }
    }

    this.previousInput = input;
    return this.result(input);
  }

  reconcileHost(hostValue: number, timestamp = Date.now()): SafeInputResult {
    void timestamp;
    const host = clamp01(hostValue);
    this.initialized = true;
    this.currentHostValue = host;
    this.currentValue = host;
    const input = this.previousInput ?? host;
    this.captured = Math.abs(input - host) <= this.deadzone;
    this.state = this.captured ? "active" : "takeover";
    return this.result(input);
  }

  markLost(timestamp = Date.now()): SafeInputResult {
    if (!this.initialized) {
      this.initialized = true;
      this.currentValue = this.loss.neutralValue;
      this.currentHostValue = this.currentValue;
    }
    this.lostAt = timestamp;
    this.lostFrom = this.currentValue;
    this.captured = false;
    this.state = "lost";
    return this.result(this.previousInput ?? this.currentValue);
  }

  tick(timestamp = Date.now()): SafeInputResult {
    if (this.lostAt === null) return this.result(this.previousInput ?? this.currentValue);
    const elapsed = Math.max(0, timestamp - this.lostAt);
    if (elapsed <= this.loss.holdMs) {
      this.state = "lost";
    } else {
      const progress = clamp01((elapsed - this.loss.holdMs) / this.loss.releaseMs);
      this.currentValue = this.lostFrom + (this.loss.neutralValue - this.lostFrom) * progress;
      this.currentHostValue = this.currentValue;
      this.state = progress < 1 ? "decaying" : "idle";
    }
    return this.result(this.previousInput ?? this.currentValue);
  }

  snapshot(): SafeInputResult {
    return this.result(this.previousInput ?? this.currentValue);
  }

  private result(input: number): SafeInputResult {
    const diff = this.currentHostValue - input;
    const direction: -1 | 0 | 1 = Math.abs(diff) <= this.deadzone ? 0 : diff > 0 ? 1 : -1;
    return {
      value: clamp01(this.currentValue),
      state: this.state,
      captured: this.captured,
      hostValue: clamp01(this.currentHostValue),
      direction,
    };
  }
}

export class SafeInputRegistry {
  private readonly inputs = new Map<string, SafeContinuousInput>();

  has(key: string): boolean {
    return this.inputs.has(key);
  }

  hasMatchingConfig(key: string, config: SafeContinuousInputOptions = {}): boolean {
    return this.inputs.get(key)?.matchesConfig(config) ?? false;
  }

  process(key: string, value: number, options: ProcessOptions = {}, config: SafeContinuousInputOptions = {}): SafeInputResult {
    let input = this.inputs.get(key);
    if (!input || !input.matchesConfig(config)) {
      input = new SafeContinuousInput(config);
      this.inputs.set(key, input);
    }
    return input.process(value, options);
  }

  reconcileHost(key: string, value: number, timestamp = Date.now()): SafeInputResult | null {
    return this.inputs.get(key)?.reconcileHost(value, timestamp) ?? null;
  }

  snapshot(key: string): SafeInputResult | null {
    return this.inputs.get(key)?.snapshot() ?? null;
  }

  markLost(prefix: string, timestamp = Date.now()): Record<string, SafeInputResult> {
    const result: Record<string, SafeInputResult> = {};
    for (const [key, input] of this.inputs) {
      if (key.startsWith(prefix)) result[key] = input.markLost(timestamp);
    }
    return result;
  }

  deletePrefix(prefix: string): void {
    for (const key of this.inputs.keys()) {
      if (key.startsWith(prefix)) this.inputs.delete(key);
    }
  }

  deleteControl(controlName: string): void {
    const marker = `::${controlName}::`;
    for (const key of this.inputs.keys()) {
      if (key.includes(marker)) this.inputs.delete(key);
    }
  }

  clear(): void {
    this.inputs.clear();
  }

  diagnostics(): Record<string, SafeInputResult> {
    const result: Record<string, SafeInputResult> = {};
    for (const [key, input] of this.inputs) result[key] = input.snapshot();
    return result;
  }
}

export interface SafeSignalFilterOptions {
  smoothingAlpha?: number;
  deadzone?: number;
  outlierDelta?: number;
}

export class SafeSignalFilter {
  private readonly smoothingAlpha: number;
  private readonly deadzone: number;
  private readonly outlierDelta: number;
  private value = 0;
  private initialized = false;
  private pendingOutlier: number | null = null;

  constructor(options: SafeSignalFilterOptions = {}) {
    this.smoothingAlpha = clamp01(options.smoothingAlpha ?? 0.55);
    this.deadzone = Math.max(0, options.deadzone ?? 0.004);
    this.outlierDelta = Math.max(0, options.outlierDelta ?? 0.35);
  }

  process(rawValue: number, timestamp = Date.now()): { value: number; state: SafeInputState; timestamp: number } {
    if (!Number.isFinite(rawValue)) return { value: this.value, state: "error", timestamp };
    const raw = clamp01(rawValue);
    if (!this.initialized) {
      this.initialized = true;
      this.value = raw;
      return { value: this.value, state: "active", timestamp };
    }
    if (Math.abs(raw - this.value) > this.outlierDelta) {
      if (this.pendingOutlier === null || Math.abs(raw - this.pendingOutlier) > this.deadzone * 2) {
        this.pendingOutlier = raw;
        return { value: this.value, state: "unstable", timestamp };
      }
      this.pendingOutlier = null;
    } else {
      this.pendingOutlier = null;
    }
    if (Math.abs(raw - this.value) > this.deadzone) {
      this.value = clamp01(this.value + (raw - this.value) * this.smoothingAlpha);
    }
    return { value: this.value, state: "active", timestamp };
  }
}
