// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { clearExtensionContext, setExtensionContext } from "../src/context.ts";
import {
  activeSmooths,
  commands,
  configureMappingStorage,
  controlMappings,
  eventModesState,
  hostModulators,
  lastMappedValues,
  runMappingMutation,
  safeInputRegistry,
  setMappingsFilePath,
} from "../src/live/mappings.ts";

function resetMappingState() {
  controlMappings.clear();
  safeInputRegistry.clear();
  lastMappedValues.clear();
  eventModesState.clear();
  activeSmooths.clear();
  hostModulators.clear();
  setMappingsFilePath(null);
}

function fakeSong() {
  const param = { name: "Frequency", min: 20, max: 20000, isQuantized: false, valueItems: [], handle: { id: 3n } };
  return {
    tempo: 120,
    tracks: [{ name: "Bass", handle: { id: 1n }, devices: [{ name: "Filter", handle: { id: 2n }, parameters: [param] }] }],
    returnTracks: [],
    mainTrack: { name: "Main", handle: { id: 4n }, devices: [] },
  };
}

test("clearMappings restores authoritative state when persistence fails", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcsurface-clear-fail-"));
  resetMappingState();
  setMappingsFilePath(dir);
  controlMappings.set("fader-1", [{ type: "tempo" }]);
  lastMappedValues.set("fader-1::tempo", 0.42);
  eventModesState.set("fader-1::tempo", { lastInput: 0.42, active: true });
  activeSmooths.set("fader-1::tempo", {
    current: 0.42,
    target: 0.9,
    smoothFactor: 0.25,
    lastTime: 0,
    apply: async () => {},
  });

  try {
    await assert.rejects(commands.clearMappings.handler({}));
    assert.equal(controlMappings.has("fader-1"), true);
    assert.equal(lastMappedValues.get("fader-1::tempo"), 0.42);
    assert.equal(eventModesState.has("fader-1::tempo"), true);
    assert.equal(activeSmooths.has("fader-1::tempo"), true);
  } finally {
    resetMappingState();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("clearMappings persists an empty mapping set before resetting derived state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcsurface-clear-ok-"));
  const mappingFile = path.join(dir, "mappings.json");
  const applied = [];
  resetMappingState();
  setMappingsFilePath(mappingFile);
  controlMappings.set("fader-1", [{ type: "tempo" }]);
  lastMappedValues.set("fader-1::tempo", 0.42);
  eventModesState.set("fader-1::tempo", { lastInput: 0.42, active: true });
  activeSmooths.set("fader-1::tempo", {
    current: 0.42,
    target: 0.9,
    smoothFactor: 0.25,
    lastTime: 0,
    apply: async (value) => { applied.push(value); },
  });

  try {
    const result = await commands.clearMappings.handler({});
    assert.deepEqual(result, { cleared: 1 });
    assert.equal(controlMappings.size, 0);
    assert.equal(lastMappedValues.size, 0);
    assert.equal(eventModesState.size, 0);
    assert.equal(activeSmooths.size, 0);
    assert.deepEqual(applied, [0]);
    assert.deepEqual(JSON.parse(await fs.readFile(mappingFile, "utf8")), {});
  } finally {
    resetMappingState();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("clearMappings leaves mappings.json intact when the project profile write fails", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcsurface-clear-project-fail-"));
  const mappingFile = path.join(dir, "mappings.json");
  const projectsPath = path.join(dir, "projects");
  const originalMappings = { "fader-1": [{ type: "tempo" }] };
  resetMappingState();
  await configureMappingStorage(dir);
  setExtensionContext({
    application: { song: { tracks: [], returnTracks: [], mainTrack: null } },
  });
  controlMappings.set("fader-1", [{ type: "tempo" }]);
  await fs.writeFile(mappingFile, JSON.stringify(originalMappings, null, 2), "utf8");
  await fs.rm(projectsPath, { recursive: true, force: true });
  await fs.writeFile(projectsPath, "blocks project profile writes", "utf8");

  try {
    await assert.rejects(commands.clearMappings.handler({}));
    assert.deepEqual(JSON.parse(await fs.readFile(mappingFile, "utf8")), originalMappings);
    assert.deepEqual(controlMappings.get("fader-1"), [{ type: "tempo" }]);
  } finally {
    clearExtensionContext();
    await configureMappingStorage(null);
    resetMappingState();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("failed project import preserves safe-input diagnostics", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcsurface-import-safe-fail-"));
  const projectsPath = path.join(dir, "projects");
  resetMappingState();
  setExtensionContext({ application: { song: fakeSong() } });

  try {
    await configureMappingStorage(dir);
    controlMappings.set("knob-1", [{ type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 }]);
    const exported = await commands.exportProjectConfig.handler({});
    safeInputRegistry.process("phone-1::knob-1::device-param", 0.42, { hostValue: 0.25, timestamp: 100 });
    const diagnosticsBefore = safeInputRegistry.diagnostics();

    await fs.rm(projectsPath, { recursive: true, force: true });
    await fs.writeFile(projectsPath, "blocks project profile writes", "utf8");

    await assert.rejects(commands.importProjectConfig.handler({ content: exported.content }));
    assert.deepEqual(safeInputRegistry.diagnostics(), diagnosticsBefore);
  } finally {
    clearExtensionContext();
    await configureMappingStorage(null);
    resetMappingState();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("mapping mutations execute serially", async () => {
  const order = [];
  let releaseFirst;
  const first = runMappingMutation(async () => {
    order.push("first:start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    order.push("first:end");
  });
  const second = runMappingMutation(async () => {
    order.push("second:start");
    order.push("second:end");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("project client state saves wait for mapping mutations", async () => {
  let releaseMutation;
  const blocker = runMappingMutation(() => new Promise((resolve) => {
    releaseMutation = resolve;
  }));
  let clientStateSaved = false;
  const clientStateSave = commands.saveProjectClientState.handler({ pages: { active: "mix" } })
    .then(() => { clientStateSaved = true; });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clientStateSaved, false);

  releaseMutation();
  await Promise.all([blocker, clientStateSave]);
  assert.equal(clientStateSaved, true);
});
