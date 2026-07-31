// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Test suite for Task 3.4 — Modularized catalog exports

import test from "node:test";
import assert from "node:assert/strict";

test("src/live/catalog/index.ts exports complete set of modular commands", async () => {
  await import("../src/live/mappings.ts");
  const { commands } = await import("../src/live/catalog/index.ts");
  assert.ok(commands, "commands catalog must be exported");

  // Verify key commands from each category exist
  const expectedCommands = [
    // Transport
    "getTransportLiteState",
    "refreshTransportLocators",
    "transportPlay",
    "transportStop",
    "transportToggle",
    "transportPrevLocator",
    "transportNextLocator",
    "transportJumpToLocator",
    // Live
    "getSelectedLiveContext",
    "getState",
    "getDeviceParams",
    "setDeviceParam",
    "setTempo",
    "setTrackMute",
    "setTrackVolume",
    "setPlayhead",
    // Config
    "getProjectConfigStatus",
    "saveProjectClientState",
    "exportProjectConfig",
    "importProjectConfig",
    "confirmProjectRelink",
    "rollbackProjectConfig",
    // Mapping
    "getTargets",
    "getMappings",
    "setMapping",
    "removeMapping",
    "clearMappings",
    "highlightControl",
    "addUdpReceiverToTrack",
    // Preset
    "listPresets",
    "savePreset",
    "loadPreset",
    "deletePreset",
    // Admin
    "getServerInfo",
    "getClients",
  ];

  for (const cmd of expectedCommands) {
    assert.ok(commands[cmd], `command '${cmd}' must be present in modular catalog`);
    assert.equal(typeof commands[cmd].description, "string", `'${cmd}' must have a description string`);
    assert.equal(typeof commands[cmd].handler, "function", `'${cmd}' must have a handler function`);
  }
});
