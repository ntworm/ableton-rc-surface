// Tests for the generic device template renderer.
// Run with: node --test static/mix/generic-template.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderParameter, inputValueToWire, enumLabelFor, pickControl, CONTROL } from "./generic-template.mjs";
import { PARAM_KIND } from "./protocol.mjs";

describe("pickControl", () => {
  it("returns fader for volume / vol", () => {
    assert.equal(pickControl("Volume", false, [], false), CONTROL.FADER);
    assert.equal(pickControl("Track Volume", false, [], false), CONTROL.FADER);
    assert.equal(pickControl("vol", false, [], false), CONTROL.FADER);
  });

  it("returns knob-pan for pan and dry/wet and mix", () => {
    assert.equal(pickControl("Pan", false, [], false), CONTROL.KNOB_PAN);
    assert.equal(pickControl("Panning", false, [], false), CONTROL.KNOB_PAN);
    assert.equal(pickControl("Dry/Wet", false, [], false), CONTROL.KNOB_PAN);
    assert.equal(pickControl("DryWet", false, [], false), CONTROL.KNOB_PAN);
    assert.equal(pickControl("Mix", false, [], false), CONTROL.KNOB_PAN);
  });

  it("returns knob-log for frequency and time controls", () => {
    assert.equal(pickControl("Frequency", false, [], false), CONTROL.KNOB_LOG);
    assert.equal(pickControl("Cutoff", false, [], false), CONTROL.KNOB_LOG);
    assert.equal(pickControl("Resonance Hz", false, [], false), CONTROL.KNOB_LOG);
    assert.equal(pickControl("Attack", false, [], false), CONTROL.KNOB_LOG);
    assert.equal(pickControl("Release", false, [], false), CONTROL.KNOB_LOG);
    assert.equal(pickControl("Decay", false, [], false), CONTROL.KNOB_LOG);
    assert.equal(pickControl("Ratio", false, [], false), CONTROL.KNOB_LOG);
  });

  it("returns knob for threshold, knee, q, resonance, gain", () => {
    assert.equal(pickControl("Threshold", false, [], false), CONTROL.KNOB);
    assert.equal(pickControl("Knee", false, [], false), CONTROL.KNOB);
    assert.equal(pickControl("Q", false, [], false), CONTROL.KNOB);
    assert.equal(pickControl("Resonance", false, [], false), CONTROL.KNOB);
    assert.equal(pickControl("Gain", false, [], false), CONTROL.KNOB);
  });

  it("returns stepper for quantized with multiple valueItems", () => {
    assert.equal(pickControl("Mode", true, [{ name: "A" }, { name: "B" }], false), CONTROL.STEPPER);
  });

  it("returns toggle for quantized with one valueItem", () => {
    assert.equal(pickControl("Power", true, [{ name: "On" }], false), CONTROL.TOGGLE);
  });

  it("returns static for readOnly", () => {
    assert.equal(pickControl("Anything", false, [], true), CONTROL.STATIC);
  });

  it("returns knob default for unknown names", () => {
    assert.equal(pickControl("MysteryParam", false, [], false), CONTROL.KNOB);
    assert.equal(pickControl("", false, [], false), CONTROL.KNOB);
  });

  it("is case-insensitive", () => {
    assert.equal(pickControl("VOLUME", false, [], false), CONTROL.FADER);
    assert.equal(pickControl("Pan", false, [], false), CONTROL.KNOB_PAN);
    assert.equal(pickControl("PAN", false, [], false), CONTROL.KNOB_PAN);
  });
});

describe("renderParameter", () => {
  it("renders a volume param as a fader with the fader class", () => {
    const out = renderParameter({
      id: "mix:track:0:dev:0:par:0",
      name: "Volume",
      value: 0.5,
      kind: PARAM_KIND.CONTINUOUS,
    });
    assert.match(out.html, /class="[^"]*ctrl-fader[^"]*"/);
    assert.match(out.html, /Volume/);
    assert.equal(out.event.type, "mix.setParam");
  });

  it("renders a pan param as a knob-pan with the pan class", () => {
    const out = renderParameter({
      id: "mix:track:0:dev:0:par:1",
      name: "Pan",
      value: 0.5,
      kind: PARAM_KIND.CONTINUOUS,
    });
    assert.match(out.html, /ctrl-knob/);
    assert.match(out.html, /ctrl-knob-pan/);
    assert.match(out.html, /\u2194/);  // ↔ hint
  });

  it("renders a dry/wet param as knob-pan", () => {
    const out = renderParameter({
      id: "mix:track:0:dev:0:par:2",
      name: "Dry/Wet",
      value: 0.5,
      kind: PARAM_KIND.CONTINUOUS,
    });
    assert.match(out.html, /ctrl-knob-pan/);
  });

  it("renders a frequency param as knob-log with a log hint", () => {
    const out = renderParameter({
      id: "x",
      name: "Frequency",
      value: 0.5,
      kind: PARAM_KIND.CONTINUOUS,
    });
    assert.match(out.html, /ctrl-knob-log/);
    assert.match(out.html, /log/);
  });

  it("renders an attack param as knob-log", () => {
    const out = renderParameter({
      id: "x",
      name: "Attack",
      value: 0.3,
      kind: PARAM_KIND.CONTINUOUS,
    });
    assert.match(out.html, /ctrl-knob-log/);
  });

  it("renders an enum parameter as a stepper with discrete steps", () => {
    const out = renderParameter({
      id: "x",
      name: "Mode",
      value: 0.5,
      kind: PARAM_KIND.ENUM,
      valueItems: [{ name: "Soft" }, { name: "Hard" }, { name: "Bypass" }],
    });
    assert.match(out.html, /class="[^"]*ctrl-stepper[^"]*"/);
    assert.match(out.html, /max="2" step="1"/);
    assert.equal(out.event.type, "mix.setParam");
  });

  it("renders a two-state quantised parameter as a checkbox", () => {
    const out = renderParameter({
      id: "x",
      name: "Power",
      value: 1,
      kind: PARAM_KIND.TOGGLE,
      valueItems: [{ name: "On" }],
    });
    assert.match(out.html, /type="checkbox"/);
    assert.match(out.html, /ctrl-toggle/);
    assert.match(out.html, /checked/);
  });

  it("renders a read-only parameter as a static value with no input", () => {
    const out = renderParameter({
      id: "x",
      name: "ReadOnly",
      value: 0.42,
      kind: PARAM_KIND.DISABLED,
    });
    assert.doesNotMatch(out.html, /type="range"/);
    assert.doesNotMatch(out.html, /type="checkbox"/);
    assert.equal(out.event, null);
    assert.match(out.html, /0\.42/);
  });

  it("returns empty html and null event for a missing descriptor", () => {
    const out = renderParameter(null);
    assert.equal(out.html, "");
    assert.equal(out.event, null);
  });

  it("clamps the rendered value to 0..1", () => {
    const out = renderParameter({
      id: "x", name: "Volume", value: 5, kind: PARAM_KIND.CONTINUOUS,
    });
    assert.match(out.html, /value="1"/);
  });

  it("escapes html in the parameter name", () => {
    const out = renderParameter({
      id: "x", name: "<script>alert(1)</script>", value: 0,
      kind: PARAM_KIND.CONTINUOUS,
    });
    assert.doesNotMatch(out.html, /<script>alert/);
    assert.match(out.html, /&lt;script&gt;/);
  });
});

describe("inputValueToWire", () => {
  it("clamps a continuous value to 0..1", () => {
    assert.equal(inputValueToWire(0.42, PARAM_KIND.CONTINUOUS), 0.42);
    assert.equal(inputValueToWire(2, PARAM_KIND.CONTINUOUS), 1);
    assert.equal(inputValueToWire(-1, PARAM_KIND.CONTINUOUS), 0);
  });

  it("maps an enum step index back to 0..1", () => {
    assert.equal(inputValueToWire(0, PARAM_KIND.ENUM, 3), 0);
    assert.equal(inputValueToWire(1, PARAM_KIND.ENUM, 3), 0.5);
    assert.equal(inputValueToWire(2, PARAM_KIND.ENUM, 3), 1);
  });

  it("clamps enum step out-of-range", () => {
    assert.equal(inputValueToWire(99, PARAM_KIND.ENUM, 3), 1);
    assert.equal(inputValueToWire(-1, PARAM_KIND.ENUM, 3), 0);
  });

  it("converts a toggle 1/0 to wire value", () => {
    assert.equal(inputValueToWire(1, PARAM_KIND.TOGGLE), 1);
    assert.equal(inputValueToWire(0, PARAM_KIND.TOGGLE), 0);
    assert.equal(inputValueToWire(true, PARAM_KIND.TOGGLE), 1);
  });

  it("returns 0 for non-numeric input", () => {
    assert.equal(inputValueToWire(NaN, PARAM_KIND.CONTINUOUS), 0);
    assert.equal(inputValueToWire("x", PARAM_KIND.CONTINUOUS), 0);
  });
});

describe("enumLabelFor", () => {
  const items = [{ name: "Soft" }, { name: "Medium" }, { name: "Hard" }];

  it("picks the first label for value 0", () => {
    assert.equal(enumLabelFor(0, items), "Soft");
  });

  it("picks the last label for value 1", () => {
    assert.equal(enumLabelFor(1, items), "Hard");
  });

  it("picks the middle label for value 0.5", () => {
    assert.equal(enumLabelFor(0.5, items), "Medium");
  });

  it("clamps out-of-range values to the extremes", () => {
    assert.equal(enumLabelFor(-0.1, items), "Soft");
    assert.equal(enumLabelFor(1.1, items), "Hard");
  });

  it("returns empty string when valueItems is empty", () => {
    assert.equal(enumLabelFor(0.5, []), "");
    assert.equal(enumLabelFor(0.5, null), "");
  });
});
