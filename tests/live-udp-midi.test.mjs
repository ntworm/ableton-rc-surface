// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import assert from "node:assert/strict";
import test from "node:test";

import { clearExtensionContext, setExtensionContext } from "../src/context.ts";
import { commands, applyMapping, controlMappings, eventModesState, lastMappedValues, getTargetKey } from "../src/live/mappings.ts";
import { noteNameToMidiNumber, closeUdpSocket } from "../src/live/udp-midi.ts";

test.afterEach(() => {
  clearExtensionContext();
  controlMappings.clear();
  eventModesState.clear();
  lastMappedValues.clear();
  closeUdpSocket();
});

test("noteNameToMidiNumber uses the Live-facing octave convention", () => {
  assert.equal(noteNameToMidiNumber("C-2"), 0);
  assert.equal(noteNameToMidiNumber("C3"), 60);
  assert.equal(noteNameToMidiNumber("C7"), 108);
  assert.equal(noteNameToMidiNumber("G#7"), 116);
  assert.equal(noteNameToMidiNumber(200), 127);
});

test("addUdpReceiverToTrack keeps an existing receiver instead of deleting it", async () => {
  const calls = [];
  const staleReceiver = { name: "RC-Midi-Receiver" };
  const otherDevice = { name: "Operator" };
  const track = {
    devices: [otherDevice, staleReceiver],
    async deleteDevice(device) {
      calls.push(["delete", device.name]);
      this.devices = this.devices.filter((candidate) => candidate !== device);
    },
    async insertDevice(name, index) {
      calls.push(["insert", name, index]);
      const inserted = { name };
      this.devices.splice(index, 0, inserted);
      return inserted;
    },
  };

  setExtensionContext({
    application: {
      song: {
        tempo: 120,
        tracks: [track],
      },
    },
  });

  const result = await commands.addUdpReceiverToTrack.handler({ trackIndex: 0 });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, {
    success: true,
    inserted: false,
    existing: true,
    receiverName: "RC-Midi-Receiver",
  });
  assert.deepEqual(
    track.devices.map((device) => device.name),
    ["Operator", "RC-Midi-Receiver"],
  );
});

// ── trigger_note identity regressions ─────────────────────────────────────────

test("getTargetKey: trigger_note does not collide with device_param track 0 / device 0 / param 0", () => {
  const triggerTarget = { type: "device_param", mode: "trigger_note", trackIndex: 0, midiNote: "C3" };
  const deviceParamTarget = { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 };
  const triggerKey = getTargetKey(triggerTarget);
  const deviceKey = getTargetKey(deviceParamTarget);
  assert.notEqual(triggerKey, deviceKey,
    `trigger_note key '${triggerKey}' must differ from device_param key '${deviceKey}'`);
  assert.ok(triggerKey.startsWith("trigger_note::"),
    `trigger_note key should start with 'trigger_note::', got '${triggerKey}'`);
});

test("pad-1 and pad-2 can create trigger_note on the same MIDI track with different notes without sharing eventModesState", async () => {
  const midiSent = [];
  // Override the UDP socket so sendMidiNote is captured instead of sent
  const { setUdpSocketForTest } = await import("../src/live/udp-midi.ts").then(async (m) => {
    // Patch by registering a loopback: we'll observe eventModesState instead
    return {};
  });

  const midiTrack = { devices: [], tempo: 120 };
  setExtensionContext({
    application: { song: { tempo: 120, tracks: [midiTrack] } },
  });

  controlMappings.set("pad-1", [
    { type: "device_param", mode: "trigger_note", trackIndex: 0, midiNote: "C3" },
  ]);
  controlMappings.set("pad-2", [
    { type: "device_param", mode: "trigger_note", trackIndex: 0, midiNote: "D3" },
  ]);

  // Drive pad-1 and pad-2 independently
  await applyMapping("client-1", "pad-1", 1.0);
  await applyMapping("client-1", "pad-2", 1.0);

  // Each control must have its own distinct eventModesState entry
  const pad1Key = `client-1::pad-1::trigger_note::0::C3`;
  const pad2Key = `client-1::pad-2::trigger_note::0::D3`;

  assert.ok(eventModesState.has(pad1Key), `expected eventModesState key '${pad1Key}'`);
  assert.ok(eventModesState.has(pad2Key), `expected eventModesState key '${pad2Key}'`);
  assert.notEqual(
    eventModesState.get(pad1Key),
    eventModesState.get(pad2Key),
    "pad-1 and pad-2 must have separate modeState objects",
  );
});

test("backend does not suppress note-on for second control when first control is already pressed", async () => {
  const midiTrack = { devices: [], tempo: 120 };
  setExtensionContext({
    application: { song: { tempo: 120, tracks: [midiTrack] } },
  });

  controlMappings.set("pad-1", [
    { type: "device_param", mode: "trigger_note", trackIndex: 0, midiNote: "C3" },
  ]);
  controlMappings.set("pad-2", [
    { type: "device_param", mode: "trigger_note", trackIndex: 0, midiNote: "D3" },
  ]);

  // Press pad-1 (note-on for C3)
  await applyMapping("client-1", "pad-1", 1.0);
  const pad1State = eventModesState.get("client-1::pad-1::trigger_note::0::C3");
  assert.ok(pad1State, "pad-1 modeState should exist");
  assert.ok(pad1State.lastInput >= 0.5, "pad-1 should record pressed state");

  // pad-2 must be independent — pressing it should not be blocked by pad-1's state
  await applyMapping("client-1", "pad-2", 0.0); // start released
  await applyMapping("client-1", "pad-2", 1.0); // press — should fire note-on for D3
  const pad2State = eventModesState.get("client-1::pad-2::trigger_note::0::D3");
  assert.ok(pad2State, "pad-2 modeState should exist");
  assert.ok(pad2State.lastInput >= 0.5, "pad-2 should record its own pressed state independently");
});
