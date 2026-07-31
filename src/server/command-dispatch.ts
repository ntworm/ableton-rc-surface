// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import { SessionRole, Session } from "./session-auth.js";
import { commands } from "../live/mappings.js";

/**
 * "mapping-write" exists because the MAP panel lives in the PHONE UI, and the
 * phone authenticates as `controller`. Editing its own mappings and presets is
 * the controller's job, so lumping it in with `config-write` made binding a
 * control fail with "Requires 'admin' role" — and with no mapping stored, no
 * sensor, pad or vision value could ever move a Live parameter.
 *
 * "config-write" stays admin-only and now means what it says: operations on the
 * whole project configuration (export, import, rollback).
 */
export type SideEffect = "read" | "live-write" | "mapping-write" | "config-write" | "server-admin";

export interface CommandMetadata {
  description: string;
  sideEffect: SideEffect;
  requiredRole: SessionRole;
}

export const COMMAND_SIDE_EFFECTS: Record<string, SideEffect> = {
  // Read side effects (viewer, controller, admin)
  getState: "read",
  getDeviceParams: "read",
  getProjectConfigStatus: "read",
  getTargets: "read",
  getMappings: "read",
  listPresets: "read",
  getSelectedLiveContext: "read",
  getClients: "read",
  getTransportLiteState: "read",

  // Live-write side effects (controller, admin)
  transportPlay: "live-write",
  transportStop: "live-write",
  transportToggle: "live-write",
  transportPrevLocator: "live-write",
  transportNextLocator: "live-write",
  refreshTransportLocators: "live-write",
  setDeviceParam: "live-write",
  setTempo: "live-write",
  setTrackMute: "live-write",
  setTrackVolume: "live-write",
  setPlayhead: "live-write",
  transportJumpToLocator: "live-write",
  addUdpReceiverToTrack: "live-write",
  highlightControl: "live-write",

  // Mapping-write side effects (controller, admin) — everything the phone's
  // own MAP panel needs to bind a control and manage its presets.
  saveProjectClientState: "mapping-write",
  confirmProjectRelink: "mapping-write",
  setMapping: "mapping-write",
  removeMapping: "mapping-write",
  clearMappings: "mapping-write",
  savePreset: "mapping-write",
  loadPreset: "mapping-write",
  deletePreset: "mapping-write",

  // Config-write side effects (admin only) — whole-project configuration.
  exportProjectConfig: "config-write",
  importProjectConfig: "config-write",
  rollbackProjectConfig: "config-write",

  // Server-admin side effects (admin only)
  getServerInfo: "server-admin",
};

export function getRequiredRoleForSideEffect(sideEffect: SideEffect): SessionRole {
  switch (sideEffect) {
    case "read":
      return "viewer";
    case "live-write":
    case "mapping-write":
      return "controller";
    case "config-write":
    case "server-admin":
      return "admin";
  }
}

export function isRoleAuthorized(role: SessionRole, sideEffect: SideEffect): boolean {
  if (role === "admin") return true;
  if (role === "controller") {
    return sideEffect === "read" || sideEffect === "live-write" || sideEffect === "mapping-write";
  }
  if (role === "viewer") {
    return sideEffect === "read";
  }
  return false;
}

export interface CommandEnvelope {
  id?: string | undefined;
  cmd: string;
  args?: Record<string, unknown> | undefined;
}

export interface DispatchResult {
  id?: string | undefined;
  ok: boolean;
  result?: unknown;
  error?: string | undefined;
}

export async function dispatchCommand(
  roleOrSession: SessionRole | Session,
  envelope: CommandEnvelope,
): Promise<DispatchResult> {
  const role: SessionRole =
    typeof roleOrSession === "object" && roleOrSession !== null
      ? roleOrSession.role
      : roleOrSession;
  const { id, cmd, args = {} } = envelope;
  const spec = commands[cmd];
  if (!spec) {
    const known = Object.keys(commands).join(", ");
    return { id, ok: false, error: `unknown cmd: ${cmd}. known: ${known}` };
  }

  const sideEffect = COMMAND_SIDE_EFFECTS[cmd] ?? "config-write";
  if (!isRoleAuthorized(role, sideEffect)) {
    const requiredRole = getRequiredRoleForSideEffect(sideEffect);
    return {
      id,
      ok: false,
      error: `Unauthorized: role '${role}' cannot execute '${sideEffect}' command '${cmd}'. Requires '${requiredRole}' role.`,
    };
  }

  try {
    const result = await spec.handler(args);
    return { id, ok: true, result };
  } catch (err) {
    const detail =
      err === undefined
        ? "<undefined>"
        : err instanceof Error
          ? err.message
          : JSON.stringify(err);
    return { id, ok: false, error: detail };
  }
}

export function getPublicCommandsMetadata(): Record<string, CommandMetadata> {
  const meta: Record<string, CommandMetadata> = {};
  for (const [name, spec] of Object.entries(commands)) {
    const sideEffect = COMMAND_SIDE_EFFECTS[name] ?? "config-write";
    meta[name] = {
      description: spec.description,
      sideEffect,
      requiredRole: getRequiredRoleForSideEffect(sideEffect),
    };
  }
  return meta;
}
