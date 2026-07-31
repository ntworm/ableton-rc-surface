// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  configureMappingStorage,
  commands,
  controlMappings,
  getProjectConfigStatus,
  loadMappings,
  saveMappings,
} from "../src/live/mappings.ts";
import { clearExtensionContext, setExtensionContext } from "../src/context.ts";

function fakeSong() {
  const param = { name: "Frequency", min: 20, max: 20000, isQuantized: false, valueItems: [], handle: { id: 3n } };
  return {
    tempo: 120,
    tracks: [{ name: "Bass", handle: { id: 1n }, devices: [{ name: "Filter", handle: { id: 2n }, parameters: [param] }] }],
    returnTracks: [],
    mainTrack: { name: "Main", handle: { id: 4n }, devices: [] },
  };
}

test("mapping persistence writes and restores a versioned per-set .rcsurface profile", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcsurface-store-"));
  setExtensionContext({ application: { song: fakeSong() } });
  try {
    await configureMappingStorage(dir);
    controlMappings.clear();
    controlMappings.set("knob-1", [{ type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 }]);
    await saveMappings();

    const projects = await fs.readdir(path.join(dir, "projects"));
    assert.equal(projects.filter((name) => name.endsWith(".rcsurface")).length, 1);

    controlMappings.clear();
    await loadMappings();
    assert.equal(controlMappings.has("knob-1"), true);
    const status = getProjectConfigStatus();
    assert.equal(status.loaded, true);
    assert.equal(status.report.total, 1);
    assert.equal(status.file, path.basename(status.file));
    assert.doesNotMatch(status.file, /[\\/]/);
  } finally {
    controlMappings.clear();
    clearExtensionContext();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("project export/import transfers validated content without remote filesystem paths", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcsurface-transfer-"));
  setExtensionContext({ application: { song: fakeSong() } });
  try {
    await configureMappingStorage(dir);
    controlMappings.clear();
    controlMappings.set("knob-1", [{ type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 }]);
    const exported = await commands.exportProjectConfig.handler({});
    assert.match(exported.filename, /\.rcsurface$/);
    assert.equal(JSON.parse(exported.content).format, "ableton-rc-surface-project");

    controlMappings.clear();
    await commands.importProjectConfig.handler({ content: exported.content });
    assert.equal(controlMappings.has("knob-1"), true);
    controlMappings.get("knob-1")[0].relinkCandidates = [
      { target: { type: "tempo" }, confidence: 1 },
    ];
    await assert.rejects(
      commands.confirmProjectRelink.handler({ control: "knob-1", targetIndex: 0, candidateIndex: 0 }),
      /not awaiting confirmation/,
    );
    await assert.rejects(
      commands.importProjectConfig.handler({ content: '{"bad":true}' }),
      /Invalid .rcsurface/,
    );
  } finally {
    controlMappings.clear();
    clearExtensionContext();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
