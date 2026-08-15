// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildProjectConfig,
  captureTargetSignature,
  loadProjectConfigFile,
  relinkProjectConfig,
  rollbackProjectConfigFile,
  saveProjectConfigFile,
  scoreSemanticMatch,
  validateProjectConfig,
} from "../src/live/project-config.ts";

function parameter(name, min = 0, max = 1, id = 10n) {
  return { name, min, max, isQuantized: false, valueItems: [], handle: { id } };
}

function song() {
  return {
    tempo: 120,
    tracks: [
      { name: "Bass", handle: { id: 1n }, devices: [{ name: "Auto Filter", handle: { id: 2n }, parameters: [parameter("Frequency", 20, 20000, 3n)] }] },
      { name: "Drums", handle: { id: 4n }, devices: [{ name: "Drum Rack", handle: { id: 5n }, parameters: [parameter("Macro 1", 0, 1, 6n)] }] },
    ],
    returnTracks: [],
    mainTrack: { name: "Main", handle: { id: 7n }, devices: [] },
  };
}

test("semantic signature stores available stable identity and parameter traits", () => {
  const signature = captureTargetSignature(song(), {
    type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0,
  });
  assert.equal(signature.trackName, "Bass");
  assert.equal(signature.deviceName, "Auto Filter");
  assert.equal(signature.parameterName, "Frequency");
  assert.equal(signature.parameterMin, 20);
  assert.equal(signature.parameterMax, 20000);
  assert.equal(signature.parameterPersistentId, undefined);
  assert.equal(signature.parameterSessionId, "3");
});

test("semantic signature includes mixer parameters and sends", () => {
  const current = song();
  current.tracks[0].mixer = {
    volume: { ...parameter("Volume", 0, 1, 20n) },
    panning: { ...parameter("Pan", -1, 1, 21n) },
    sends: [{ ...parameter("Send A", 0, 1, 22n) }],
  };
  const signature = captureTargetSignature(current, { type: "mixer_send", trackIndex: 0, sendIndex: 0 });
  assert.equal(signature.deviceName, "Track Mixer");
  assert.equal(signature.parameterName, "Send A");
  assert.equal(signature.parameterSessionId, "22");
});

test("semantic scoring prefers persistent identity but survives simple reordering", () => {
  const expected = captureTargetSignature(song(), {
    type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0,
  });
  const reordered = { ...expected, trackIndex: 4, deviceIndex: 2 };
  const wrong = { ...expected, parameterSessionId: "99", parameterName: "Resonance", deviceName: "Compressor" };
  assert.ok(scoreSemanticMatch(expected, reordered) > 0.9);
  assert.ok(scoreSemanticMatch(expected, wrong) < 0.6);
});

test("relink auto-connects high confidence and preserves missing mappings", () => {
  const mappings = new Map([
    ["knob-1", [{ type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 }]],
    ["knob-2", [{
      type: "device_param", trackIndex: 9, deviceIndex: 9, paramIndex: 9,
      signature: { trackName: "Gone", deviceName: "Missing", parameterName: "Nope" },
    }]],
  ]);
  const config = buildProjectConfig(song(), mappings, {});
  const movedSong = song();
  movedSong.tracks.reverse();
  const result = relinkProjectConfig(config, movedSong);
  assert.equal(result.report.relinked, 1);
  assert.equal(result.report.missing, 1);
  assert.equal(result.mappings.get("knob-1")[0].trackIndex, 1);
  assert.equal(result.mappings.has("knob-2"), true);
  assert.equal(result.mappings.get("knob-2")[0].relinkStatus, "missing");
});

test("relink never trusts candidate targets embedded in an imported profile", () => {
  const config = buildProjectConfig(song(), new Map([
    ["knob-1", [{
      type: "device_param", trackIndex: 99, deviceIndex: 99, paramIndex: 99,
      signature: { trackName: "Gone", deviceName: "Gone", parameterName: "Gone" },
      relinkCandidates: [{ target: { type: "tempo" }, confidence: 1 }],
    }]],
  ]), {});
  const target = relinkProjectConfig(config, song()).mappings.get("knob-1")[0];
  assert.equal(target.relinkStatus, "missing");
  assert.equal(target.relinkCandidates, undefined);
});

test("validation rejects corrupt shapes and accepts current version", () => {
  assert.throws(() => validateProjectConfig({ nope: true }), /Invalid .rcsurface/);
  const config = buildProjectConfig(song(), new Map(), {});
  assert.equal(validateProjectConfig(config).version, 1);
  assert.throws(
    () => validateProjectConfig({ ...config, mappings: [] }),
    /Invalid .rcsurface/,
  );
  assert.throws(
    () => validateProjectConfig({ ...config, preferences: [] }),
    /Invalid .rcsurface/,
  );
});

test("version zero project files migrate without dropping mappings", () => {
  const migrated = validateProjectConfig({
    format: "ableton-rc-surface-project",
    version: 0,
    project: { fingerprint: "legacy", structure: [], savedAt: "2026-01-01T00:00:00.000Z" },
    mappings: { "knob-1": [{ type: "tempo" }] },
  });
  assert.equal(migrated.version, 1);
  assert.equal(migrated.mappings["knob-1"].length, 1);
  assert.equal(migrated.preferences.globalTakeover, "scale");
});

test("legacy phone UUID mapping keys collapse into stable global controls", () => {
  const config = buildProjectConfig(song(), new Map(), {});
  config.mappings = {
    "11111111-1111-4111-8111-111111111111::knob-1": [{ type: "tempo", marker: "old" }],
    "22222222-2222-4222-8222-222222222222::knob-1": [{ type: "tempo", marker: "latest" }],
    "33333333-3333-4333-8333-333333333333::pad-1": [{ type: "tempo" }],
    "knob-2": [{ type: "tempo", marker: "global" }],
    "44444444-4444-4444-8444-444444444444::knob-2": [{ type: "tempo", marker: "legacy" }],
  };
  const migrated = validateProjectConfig(config);
  assert.deepEqual(Object.keys(migrated.mappings).sort(), ["knob-1", "knob-2", "pad-1"]);
  // Two phones claimed knob-1. Neither order is meaningful — key order comes
  // from however the file was serialised, not from when the mapping was made —
  // so the fold keeps the first and reports the other instead of silently
  // preferring whichever happened to be written last.
  assert.equal(migrated.mappings["knob-1"][0].marker, "old");
  // A global binding always outranks a per-phone one: it is the binding the
  // panel has been showing all along.
  assert.equal(migrated.mappings["knob-2"][0].marker, "global");
  assert.equal(migrated.preferences.legacyClientMappingsMigrated, true);
});

test("atomic project save creates backup and rollback restores it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcsurface-test-"));
  const file = path.join(dir, "set.rcsurface");
  const first = buildProjectConfig(song(), new Map(), { page: "performance" });
  const second = buildProjectConfig(song(), new Map(), { page: "media" });
  try {
    await saveProjectConfigFile(file, first);
    await saveProjectConfigFile(file, second);
    assert.equal((await loadProjectConfigFile(file)).preferences.page, "media");
    await rollbackProjectConfigFile(file);
    assert.equal((await loadProjectConfigFile(file)).preferences.page, "performance");
    assert.equal((await loadProjectConfigFile(`${file}.bak`)).preferences.page, "media");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
