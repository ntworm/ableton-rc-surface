// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const PROJECT_CONFIG_FORMAT = "ableton-rc-surface-project";
export const PROJECT_CONFIG_VERSION = 1;

export interface SemanticTargetSignature {
  targetType?: string | undefined;
  trackPersistentId?: string | undefined;
  trackSessionId?: string | undefined;
  trackName?: string | undefined;
  trackType?: string | undefined;
  trackKind?: string | undefined;
  trackIndex?: number | undefined;
  devicePersistentId?: string | undefined;
  deviceSessionId?: string | undefined;
  deviceName?: string | undefined;
  deviceType?: string | undefined;
  deviceIndex?: number | undefined;
  parameterPersistentId?: string | undefined;
  parameterSessionId?: string | undefined;
  parameterName?: string | undefined;
  parameterIndex?: number | undefined;
  parameterMin?: number | undefined;
  parameterMax?: number | undefined;
  isQuantized?: boolean | undefined;
  valueItems?: string[] | undefined;
  sendIndex?: number | undefined;
  lastValidatedAt?: string | undefined;
}

export interface ProjectMappingTarget extends Record<string, any> {
  type: string;
  signature?: SemanticTargetSignature | undefined;
  relinkStatus?: "loaded" | "relinked" | "review" | "ambiguous" | "missing";
  relinkConfidence?: number;
  relinkCandidates?: Array<{ target: ProjectMappingTarget; confidence: number }> | undefined;
}

export interface ProjectConfig {
  format: typeof PROJECT_CONFIG_FORMAT;
  version: typeof PROJECT_CONFIG_VERSION;
  project: {
    fingerprint: string;
    structure: string[];
    savedAt: string;
  };
  mappings: Record<string, ProjectMappingTarget[]>;
  preferences: Record<string, any>;
  camera?: Record<string, any> | undefined;
  gestures?: Record<string, any> | undefined;
  pages?: Record<string, any> | undefined;
}

export interface RelinkReport {
  loaded: number;
  relinked: number;
  review: number;
  ambiguous: number;
  missing: number;
  total: number;
  compatibility: string[];
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function persistentId(value: any): string | undefined {
  const id = value?.handle?.id;
  return id === undefined || id === null ? undefined : String(id);
}

function getTrack(song: any, target: Record<string, any>): any | undefined {
  const index = target.trackIndex ?? 0;
  if (target.trackKind === "return") return song.returnTracks?.[index];
  if (target.trackKind === "main") return song.mainTrack;
  return song.tracks?.[index];
}

export function captureTargetSignature(song: any, target: Record<string, any>): SemanticTargetSignature {
  const track = getTrack(song, target);
  const mixerTarget = target.type === "mixer_volume" || target.type === "mixer_pan" || target.type === "mixer_send";
  const device = target.type === "device_param" ? track?.devices?.[target.deviceIndex ?? 0] : mixerTarget ? track?.mixer : undefined;
  const parameter = target.type === "device_param"
    ? device?.parameters?.[target.paramIndex ?? 0]
    : target.type === "mixer_volume"
      ? track?.mixer?.volume
      : target.type === "mixer_pan"
        ? track?.mixer?.panning
        : target.type === "mixer_send"
          ? track?.mixer?.sends?.[target.sendIndex ?? 0]
          : undefined;
  return {
    targetType: target.type,
    // SDK handles are explicitly host-assigned and session-scoped. Keep them
    // as weak diagnostics, never mislabel them as persistent identities.
    trackSessionId: persistentId(track),
    trackName: track?.name,
    trackType: track?.constructor?.name,
    trackKind: target.trackKind ?? "track",
    trackIndex: target.trackIndex ?? 0,
    deviceSessionId: persistentId(device),
    deviceName: mixerTarget ? "Track Mixer" : device?.name,
    deviceType: mixerTarget ? "TrackMixer" : device?.constructor?.name,
    deviceIndex: target.deviceIndex,
    parameterSessionId: persistentId(parameter),
    parameterName: parameter?.name,
    parameterIndex: target.paramIndex,
    parameterMin: parameter?.min,
    parameterMax: parameter?.max,
    isQuantized: parameter?.isQuantized,
    valueItems: Array.isArray(parameter?.valueItems)
      ? parameter.valueItems.map((item: any) => String(item?.name ?? item?.shortName ?? ""))
      : undefined,
    sendIndex: target.sendIndex,
    lastValidatedAt: new Date().toISOString(),
  };
}

function structureOfSong(song: any): string[] {
  const rows: string[] = [];
  const visit = (track: any, kind: string) => {
    const devices = track?.devices ?? [];
    if (!devices.length) rows.push(`${kind}:${track?.name ?? ""}`);
    for (const device of devices) {
      const params = (device.parameters ?? []).map((parameter: any) =>
        `${parameter.name}:${parameter.min}:${parameter.max}:${!!parameter.isQuantized}`,
      ).sort().join("|");
      rows.push(`${kind}:${track?.name ?? ""}:${device.name ?? ""}:${params}`);
    }
  };
  for (const track of song?.tracks ?? []) visit(track, "track");
  for (const track of song?.returnTracks ?? []) visit(track, "return");
  if (song?.mainTrack) visit(song.mainTrack, "main");
  return rows.sort();
}

export function fingerprintSong(song: any): { fingerprint: string; structure: string[] } {
  const structure = structureOfSong(song);
  const fingerprint = crypto.createHash("sha256").update(structure.join("\n")).digest("hex").slice(0, 24);
  return { fingerprint, structure };
}

export function buildProjectConfig(
  song: any,
  mappings: Map<string, any[]> | Record<string, any[]>,
  preferences: Record<string, any> = {},
  extras: Pick<ProjectConfig, "camera" | "gestures" | "pages"> = {},
): ProjectConfig {
  const project = fingerprintSong(song);
  const entries = mappings instanceof Map ? [...mappings.entries()] : Object.entries(mappings);
  const serialized: Record<string, ProjectMappingTarget[]> = {};
  for (const [control, targets] of entries) {
    serialized[control] = (targets ?? []).map((target) => ({
      ...target,
      signature: {
        ...captureTargetSignature(song, target),
        ...(target.signature ?? {}),
        lastValidatedAt: new Date().toISOString(),
      },
    }));
  }
  return {
    format: PROJECT_CONFIG_FORMAT,
    version: PROJECT_CONFIG_VERSION,
    project: { ...project, savedAt: new Date().toISOString() },
    mappings: serialized,
    preferences: { globalTakeover: "scale", ...preferences },
    ...extras,
  };
}

/** `<uuid>::control-name` — a mapping bound to one specific phone. */
const LEGACY_CLIENT_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}::(.+)$/i;

export interface LegacyMappingMigration {
  mappings: Record<string, any>;
  /** How many per-phone keys were folded in. */
  migrated: number;
  /** Human-readable notes about bindings that lost the fold, for the panel. */
  conflicts: string[];
}

/**
 * Fold per-phone mapping keys onto their control name.
 *
 * The surface is shared: `fader-1` means one thing regardless of which phone
 * touches it, so a binding scoped to one phone's UUID has nowhere to live. A
 * global binding for the same control always wins — it is the one the panel
 * has been showing — and anything displaced is reported rather than dropped
 * quietly, because a mapping that vanishes without a word is how a set breaks
 * on stage.
 */
export function migrateLegacyClientMappings(raw: unknown): LegacyMappingMigration {
  const mappings: Record<string, any> = {};
  const conflicts: string[] = [];
  let migrated = 0;

  if (!isRecord(raw)) return { mappings, migrated, conflicts };

  const entries = Object.entries(raw);
  // Global keys first, so they own their control before any fold is attempted.
  for (const [control, targets] of entries) {
    if (!LEGACY_CLIENT_KEY.test(control)) mappings[control] = targets;
  }

  for (const [control, targets] of entries) {
    const match = control.match(LEGACY_CLIENT_KEY);
    if (!match) continue;
    migrated += 1;
    const stableControl = match[1];
    if (!stableControl) continue;
    if (Object.prototype.hasOwnProperty.call(mappings, stableControl)) {
      conflicts.push(
        `Two bindings claimed "${stableControl}"; kept the one already in use and dropped the copy ` +
          `saved for a single phone. Re-map it if it was the one you wanted.`,
      );
      continue;
    }
    mappings[stableControl] = targets;
  }

  return { mappings, migrated, conflicts };
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  let candidate = value as any;
  if (candidate?.format === PROJECT_CONFIG_FORMAT && candidate.version === 0
      && candidate.project && candidate.mappings && typeof candidate.mappings === "object") {
    candidate = {
      ...candidate,
      version: PROJECT_CONFIG_VERSION,
      preferences: { globalTakeover: "scale", migratedFromVersion: 0, ...(candidate.preferences ?? {}) },
    };
  }
  if (isRecord(candidate?.mappings)) {
    const migration = migrateLegacyClientMappings(candidate.mappings);
    if (migration.migrated > 0) {
      candidate = {
        ...candidate,
        mappings: migration.mappings,
        preferences: { ...(candidate.preferences ?? {}), legacyClientMappingsMigrated: true },
      };
    }
  }
  const config = candidate as Partial<ProjectConfig> | null;
  if (!config || config.format !== PROJECT_CONFIG_FORMAT || config.version !== PROJECT_CONFIG_VERSION
      || !isRecord(config.project) || typeof config.project.fingerprint !== "string"
      || !Array.isArray(config.project.structure) || config.project.structure.some((row) => typeof row !== "string")
      || typeof config.project.savedAt !== "string"
      || !isRecord(config.mappings)
      || !isRecord(config.preferences)
      || (config.camera !== undefined && !isRecord(config.camera))
      || (config.gestures !== undefined && !isRecord(config.gestures))
      || (config.pages !== undefined && !isRecord(config.pages))) {
    throw new Error("Invalid .rcsurface project configuration");
  }
  for (const [control, targets] of Object.entries(config.mappings)) {
    if (!control || control.length > 256) throw new Error("Invalid .rcsurface control name");
    if (!Array.isArray(targets) || targets.some((target) => !target || typeof target.type !== "string")) {
      throw new Error("Invalid .rcsurface mappings payload");
    }
  }
  return config as ProjectConfig;
}

type WeightedField = [keyof SemanticTargetSignature, number, "exact" | "number"];
const SCORE_FIELDS: WeightedField[] = [
  ["parameterPersistentId", 0.30, "exact"],
  ["devicePersistentId", 0.12, "exact"],
  ["trackPersistentId", 0.08, "exact"],
  ["parameterSessionId", 0.05, "exact"],
  ["deviceSessionId", 0.04, "exact"],
  ["trackSessionId", 0.03, "exact"],
  ["parameterName", 0.27, "exact"],
  ["deviceName", 0.18, "exact"],
  ["trackName", 0.15, "exact"],
  ["targetType", 0.04, "exact"],
  ["trackKind", 0.03, "exact"],
  ["isQuantized", 0.03, "exact"],
  ["parameterMin", 0.06, "number"],
  ["parameterMax", 0.06, "number"],
  ["trackIndex", 0.015, "number"],
  ["deviceIndex", 0.01, "number"],
  ["parameterIndex", 0.015, "number"],
];

export function scoreSemanticMatch(expected: SemanticTargetSignature, candidate: SemanticTargetSignature): number {
  let score = 0;
  let possible = 0;
  for (const [field, weight, kind] of SCORE_FIELDS) {
    const wanted = expected[field];
    if (wanted === undefined || wanted === null || wanted === "") continue;
    possible += weight;
    const actual = candidate[field];
    if (kind === "number" && typeof wanted === "number" && typeof actual === "number") {
      if (field === "parameterMin" || field === "parameterMax") {
        const scale = Math.max(1, Math.abs(wanted));
        score += weight * Math.max(0, 1 - Math.abs(wanted - actual) / scale);
      } else {
        score += weight * (wanted === actual ? 1 : Math.max(0, 1 - Math.abs(wanted - actual) * 0.25));
      }
    } else if (String(wanted).toLocaleLowerCase() === String(actual ?? "").toLocaleLowerCase()) {
      score += weight;
    }
  }
  return possible > 0 ? Math.max(0, Math.min(1, score / possible)) : 0;
}

function enumerateCandidates(song: any, type: string): ProjectMappingTarget[] {
  const candidates: ProjectMappingTarget[] = [];
  const tracks: Array<{ track: any; kind: string; index: number }> = [
    ...(song?.tracks ?? []).map((track: any, index: number) => ({ track, kind: "track", index })),
    ...(song?.returnTracks ?? []).map((track: any, index: number) => ({ track, kind: "return", index })),
    ...(song?.mainTrack ? [{ track: song.mainTrack, kind: "main", index: 0 }] : []),
  ];
  if (type === "tempo") return [{ type: "tempo", signature: { targetType: "tempo" } }];
  for (const { track, kind, index } of tracks) {
    const base = { trackIndex: index, trackKind: kind };
    if (["mixer_volume", "mixer_pan", "track_mute", "track_solo", "track_arm"].includes(type)) {
      const target = { type, ...base };
      candidates.push({ ...target, signature: captureTargetSignature(song, target) });
    } else if (type === "mixer_send") {
      for (let sendIndex = 0; sendIndex < (track?.mixer?.sends?.length ?? 0); sendIndex++) {
        const target = { type, ...base, sendIndex };
        candidates.push({ ...target, signature: captureTargetSignature(song, target) });
      }
    } else if (type === "device_param") {
      for (let deviceIndex = 0; deviceIndex < (track?.devices?.length ?? 0); deviceIndex++) {
        for (let paramIndex = 0; paramIndex < (track.devices[deviceIndex]?.parameters?.length ?? 0); paramIndex++) {
          const target = { type, ...base, deviceIndex, paramIndex };
          candidates.push({ ...target, signature: captureTargetSignature(song, target) });
        }
      }
    }
  }
  return candidates;
}

export function relinkProjectConfig(configValue: ProjectConfig, song: any): {
  mappings: Map<string, ProjectMappingTarget[]>;
  report: RelinkReport;
} {
  const config = validateProjectConfig(configValue);
  const report: RelinkReport = { loaded: 0, relinked: 0, review: 0, ambiguous: 0, missing: 0, total: 0, compatibility: [] };
  const mappings = new Map<string, ProjectMappingTarget[]>();
  for (const [control, targets] of Object.entries(config.mappings)) {
    const resolved: ProjectMappingTarget[] = [];
    for (const original of targets) {
      const { relinkCandidates: _untrustedCandidates, ...originalWithoutCandidates } = original;
      report.total++;
      const signature = original.signature ?? {};
      const ranked = enumerateCandidates(song, original.type)
        .map((target) => ({ target, confidence: scoreSemanticMatch(signature, target.signature ?? {}) }))
        .sort((a, b) => b.confidence - a.confidence);
      const best = ranked[0];
      const second = ranked[1];
      if (!best || best.confidence < 0.58) {
        resolved.push({ ...originalWithoutCandidates, relinkStatus: "missing", relinkConfidence: best?.confidence ?? 0 });
        report.missing++;
      } else if (second && best.confidence - second.confidence < 0.05) {
        resolved.push({ ...original, relinkStatus: "ambiguous", relinkConfidence: best.confidence, relinkCandidates: ranked.slice(0, 5) });
        report.ambiguous++;
      } else if (best.confidence < 0.82) {
        resolved.push({ ...original, relinkStatus: "review", relinkConfidence: best.confidence, relinkCandidates: ranked.slice(0, 5) });
        report.review++;
      } else {
        const moved = (original.trackIndex ?? 0) !== (best.target.trackIndex ?? 0)
          || (original.deviceIndex ?? 0) !== (best.target.deviceIndex ?? 0)
          || (original.paramIndex ?? 0) !== (best.target.paramIndex ?? 0)
          || (original.sendIndex ?? 0) !== (best.target.sendIndex ?? 0);
        resolved.push({
          ...originalWithoutCandidates,
          trackIndex: best.target.trackIndex,
          trackKind: best.target.trackKind,
          deviceIndex: best.target.deviceIndex,
          paramIndex: best.target.paramIndex,
          sendIndex: best.target.sendIndex,
          signature: best.target.signature,
          relinkStatus: moved ? "relinked" : "loaded",
          relinkConfidence: best.confidence,
        });
        if (moved) report.relinked++; else report.loaded++;
      }
    }
    mappings.set(control, resolved);
  }
  if (config.version !== PROJECT_CONFIG_VERSION) report.compatibility.push(`Migrated version ${config.version}`);
  return { mappings, report };
}

export async function loadProjectConfigFile(filePath: string): Promise<ProjectConfig> {
  const raw = await fs.readFile(filePath, "utf8");
  return validateProjectConfig(JSON.parse(raw));
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

export async function saveProjectConfigFile(filePath: string, configValue: ProjectConfig): Promise<void> {
  const config = validateProjectConfig(configValue);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${filePath}.bak`;
  await fs.writeFile(temporary, JSON.stringify(config, null, 2), "utf8");
  await loadProjectConfigFile(temporary);
  if (await exists(filePath)) {
    await fs.rm(backup, { force: true });
    await fs.rename(filePath, backup);
  }
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (await exists(backup)) await fs.rename(backup, filePath);
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function rollbackProjectConfigFile(filePath: string): Promise<void> {
  const backup = `${filePath}.bak`;
  if (!(await exists(backup))) throw new Error("No .rcsurface backup is available");
  await loadProjectConfigFile(backup);
  const displaced = `${filePath}.rollback-${process.pid}-${Date.now()}`;
  const hadCurrent = await exists(filePath);
  if (hadCurrent) await fs.rename(filePath, displaced);
  try {
    await fs.rename(backup, filePath);
  } catch (error) {
    if (hadCurrent && await exists(displaced)) await fs.rename(displaced, filePath);
    throw error;
  }
  if (hadCurrent) {
    try {
      await fs.rename(displaced, backup);
    } catch (error) {
      // The requested rollback is already active. Keep its displaced successor
      // intact and surface the failure instead of deleting either valid file.
      throw new Error(`Rollback activated but backup rotation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
