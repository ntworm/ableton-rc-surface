import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deviceListItems,
  deviceListSignature,
  resolveHistoryView,
  shortFilterChoiceLabel,
} from "./view-state.mjs";

function param(name, id) {
  return { id, deviceName: name };
}

describe("Mix view state helpers", () => {
  it("builds sorted device rows when params arrive after the track shell rendered", () => {
    const perDevice = new Map([
      ["mix:track:0:dev:2", new Map([["p2", param("Reverb", "p2")]])],
      ["mix:track:0:dev:0", new Map([["p0", param("Auto Filter", "p0")]])],
    ]);

    assert.deepEqual(deviceListItems(perDevice), [
      { id: "mix:track:0:dev:0", index: 0, name: "Auto Filter", paramCount: 1 },
      { id: "mix:track:0:dev:2", index: 2, name: "Reverb", paramCount: 1 },
    ]);
  });

  it("changes the device list signature when the params cache changes", () => {
    const empty = new Map();
    const withDevice = new Map([
      ["mix:track:0:dev:0", new Map([["p0", param("Auto Filter", "p0")]])],
    ]);

    assert.notEqual(deviceListSignature(empty), deviceListSignature(withDevice));
  });

  it("restores the view from browser history state on back navigation", () => {
    assert.deepEqual(
      resolveHistoryView({ v: { kind: "track", trackId: "mix:track:0" } }, { kind: "device", trackId: "mix:track:0", deviceId: "mix:track:0:dev:0" }),
      { kind: "track", trackId: "mix:track:0" },
    );
    assert.deepEqual(resolveHistoryView(null, { kind: "device" }), { kind: "tracks" });
  });

  it("uses short readable labels for Auto Filter segmented buttons", () => {
    assert.equal(shortFilterChoiceLabel("Lowpass 24 dB"), "LP24");
    assert.equal(shortFilterChoiceLabel("Highpass 12 dB"), "HP12");
    assert.equal(shortFilterChoiceLabel("Bandpass"), "BP");
    assert.equal(shortFilterChoiceLabel("Notch"), "NOTCH");
    assert.equal(shortFilterChoiceLabel("MS2"), "MS2");
    assert.equal(shortFilterChoiceLabel("Clean"), "CLEAN");
  });
});
