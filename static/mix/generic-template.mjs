// Generic device template renderer (pure, no DOM dependency).
//
// Given a parameter descriptor (see protocol.mjs PARAM_KIND), produce
// the HTML structure + the JSON of the event the client should send
// when the user interacts with it. No framework, no jQuery: the
// app.js wires up the listeners after the HTML is in the DOM.
//
// Hotfix v0.3.1.1: the renderer now picks the right *control* for
// the right *kind of param*, not just the right shape. The user
// mixes from a phone; a phone is not a Live UI. Faders for
// continuous level controls, knobs for "rotary" controls
// (frequency, ratio, time, dry/wet, pan), stepper for enum
// values, toggle for two-state, and a static value when the
// SDK exposes the value but no setter. The mapping is name-
// based and case-insensitive; unknown names fall back to knob.

import { PARAM_KIND } from "./protocol.mjs";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Stable per-param id for DOM binding. Sanitised so it is always
// safe to drop into an `id="..."` or `for="..."` attribute. The
// mix snapshot IDs are already unique per parameter; this just
// makes them DOM-safe.
function domId(targetId) {
  return "mix-par-" + targetId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function clampWire(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, Math.round(v * 1000) / 1000));
}

// ---------------- Control-kind selection ----------------
//
// Map a parameter to the control that feels right on a phone. The
// names are matched case-insensitively as substrings; an empty /
// unknown name falls through to the knob default. The list is
// ordered: more specific patterns first, broader patterns later.
//
// isQuantized && valueItems.length > 1  -> stepper
// isQuantized && valueItems.length === 1 -> toggle
// isQuantized && valueItems.length === 0 -> knob (treated as
//                                           continuous; some
//                                           parameters declare
//                                           isQuantized with no
//                                           labels, e.g. an int
//                                           slider)
// name matches "pan" / "dry" / "wet" / "mix" -> knob with
//                                               center detent
// name matches "freq" / "cutoff" / "hz" / "attack" / "release"
//   / "decay" / "ratio" -> knob labelled with a log-scale hint
// name matches "vol"                      -> fader (long, level
//                                               read-out next to
//                                               it)
// name matches "threshold" / "knee" / "q"  -> knob linear
// name matches "resonance" / "reso"       -> knob linear
// anything else continuous                -> knob linear
// readOnly                                -> static value
export const CONTROL = Object.freeze({
  FADER: "fader",
  KNOB: "knob",
  KNOB_PAN: "knob-pan",  // center detent
  KNOB_LOG: "knob-log",  // log-scaled (rendered as linear; labelled)
  STEPPER: "stepper",
  TOGGLE: "toggle",
  STATIC: "static",
});

export function pickControl(name, isQuantized, valueItems, isReadOnly) {
  if (isReadOnly === true) return CONTROL.STATIC;
  if (isQuantized === true) {
    if (Array.isArray(valueItems) && valueItems.length > 1) return CONTROL.STEPPER;
    if (Array.isArray(valueItems) && valueItems.length === 1) return CONTROL.TOGGLE;
    // isQuantized with no valueItems: int slider; knob is the
    // right control for it.
    return CONTROL.KNOB;
  }
  const n = (name || "").toLowerCase();
  // Center-detent knobs come first so a param named "pan/dry/wet"
  // doesn't accidentally match "pan" then "wet" in a different
  // branch.
  if (n.includes("dry") || n.includes("wet") || /\bmix\b/.test(n)) return CONTROL.KNOB_PAN;
  if (n.includes("pan")) return CONTROL.KNOB_PAN;
  if (n.includes("vol")) return CONTROL.FADER;
  if (n.includes("freq") || n.includes("cutoff") || n.includes("hz")) return CONTROL.KNOB_LOG;
  if (n.includes("attack") || n.includes("release") || n.includes("decay")) return CONTROL.KNOB_LOG;
  if (n.includes("ratio")) return CONTROL.KNOB_LOG;
  if (n.includes("resonance") || n.includes("reso")) return CONTROL.KNOB;
  if (n.includes("threshold") || n.includes("knee")) return CONTROL.KNOB;
  if (/\bq\b/.test(n)) return CONTROL.KNOB;
  if (n.includes("gain")) return CONTROL.KNOB;
  return CONTROL.KNOB;
}

// ---------------- Renderers ----------------

function renderStepper({ id, targetId, value, valueItems }) {
  const dom = domId(targetId);
  const n = Array.isArray(valueItems) ? valueItems.length : 0;
  const stepIndex = n > 1 ? Math.round(clampWire(value) * (n - 1)) : 0;
  const label = (Array.isArray(valueItems) && valueItems[stepIndex]?.name) || "";
  return `
    <div class="param-row" data-param="${escapeHtml(targetId)}" data-kind="${PARAM_KIND.ENUM}">
      <label for="${dom}"><span class="pname">${escapeHtml(id)}</span></label>
      <input type="range" class="ctrl-stepper" id="${dom}" min="0" max="${Math.max(0, n - 1)}" step="1" value="${stepIndex}" />
      <span class="pval" data-ref="pval">${escapeHtml(label)}</span>
    </div>
  `;
}

function renderToggle({ id, targetId, value, valueItems }) {
  const dom = domId(targetId);
  const labels = Array.isArray(valueItems) ? valueItems.map((v) => v?.name ?? "").join(" / ") : "On / Off";
  const checked = clampWire(value) > 0.5 ? "checked" : "";
  return `
    <div class="param-row" data-param="${escapeHtml(targetId)}" data-kind="${PARAM_KIND.TOGGLE}">
      <label for="${dom}"><span class="pname">${escapeHtml(id)}</span> <span class="pval">${escapeHtml(labels)}</span></label>
      <input type="checkbox" class="ctrl-toggle" id="${dom}" ${checked} />
    </div>
  `;
}

function renderFader({ id, targetId, value }) {
  const dom = domId(targetId);
  return `
    <div class="param-row" data-param="${escapeHtml(targetId)}" data-kind="${PARAM_KIND.CONTINUOUS}">
      <label for="${dom}"><span class="pname">${escapeHtml(id)}</span></label>
      <input type="range" class="ctrl-fader" id="${dom}" min="0" max="1" step="0.001" value="${clampWire(value)}" />
      <span class="pval" data-ref="pval"></span>
    </div>
  `;
}

function renderKnob({ id, targetId, value, kind, hint }) {
  const dom = domId(targetId);
  const cls = `ctrl-knob ${kind === CONTROL.KNOB_LOG ? "ctrl-knob-log" : ""} ${kind === CONTROL.KNOB_PAN ? "ctrl-knob-pan" : ""}`.trim();
  return `
    <div class="param-row" data-param="${escapeHtml(targetId)}" data-kind="${PARAM_KIND.CONTINUOUS}">
      <label for="${dom}"><span class="pname">${escapeHtml(id)}</span>${hint ? `<span class="phint">${escapeHtml(hint)}</span>` : ""}</label>
      <input type="range" class="${cls}" id="${dom}" min="0" max="1" step="0.001" value="${clampWire(value)}" />
      <span class="pval" data-ref="pval"></span>
    </div>
  `;
}

function renderStatic({ id, targetId, value }) {
  return `
    <div class="param-row" data-param="${escapeHtml(targetId)}" data-kind="${PARAM_KIND.DISABLED}">
      <label><span class="pname">${escapeHtml(id)}</span></label>
      <span class="pval-static" data-ref="pval">${clampWire(value).toFixed(2)}</span>
    </div>
  `;
}

// The single entry point. `descriptor` is the live snapshot for one
// parameter: { id, name, value, min, max, isQuantized, valueItems, kind }.
export function renderParameter(descriptor) {
  if (!descriptor || typeof descriptor.id !== "string") {
    return { html: "", event: null };
  }
  const targetId = descriptor.id;
  const id = descriptor.name || targetId;
  const value = clampWire(descriptor.value);
  const kind = descriptor.kind;
  // The server's `kind` is the authoritative value shape. The
  // control picker (knob vs fader vs stepper vs toggle vs static)
  // decides visual shape inside that contract. Hotfix v0.3.1.1
  // takes both pieces of information into account.
  if (kind === PARAM_KIND.DISABLED) {
    return { html: renderStatic({ id, targetId, value }), event: null };
  }
  if (kind === PARAM_KIND.TOGGLE) {
    return {
      html: renderToggle({ id, targetId, value, valueItems: descriptor.valueItems }),
      event: { type: "mix.setParam" },
    };
  }
  if (kind === PARAM_KIND.ENUM) {
    return {
      html: renderStepper({ id, targetId, value, valueItems: descriptor.valueItems }),
      event: { type: "mix.setParam" },
    };
  }
  // PARAM_KIND.CONTINUOUS: pick the visual control by name.
  const control = pickControl(
    descriptor.name,
    descriptor.isQuantized,
    descriptor.valueItems,
    descriptor.isReadOnly,
  );
  switch (control) {
    case CONTROL.FADER:
      return { html: renderFader({ id, targetId, value }), event: { type: "mix.setParam" } };
    case CONTROL.KNOB_PAN:
      return { html: renderKnob({ id, targetId, value, kind: CONTROL.KNOB_PAN, hint: "↔" }), event: { type: "mix.setParam" } };
    case CONTROL.KNOB_LOG:
      return { html: renderKnob({ id, targetId, value, kind: CONTROL.KNOB_LOG, hint: "log" }), event: { type: "mix.setParam" } };
    case CONTROL.KNOB:
      return { html: renderKnob({ id, targetId, value, kind: CONTROL.KNOB }), event: { type: "mix.setParam" } };
    case CONTROL.STATIC:
    default:
      return { html: renderStatic({ id, targetId, value }), event: null };
  }
}

// Translate a raw slider/checkbox value into a wire value (0..1).
// The client uses this when the input fires a change event.
export function inputValueToWire(rawValue, kind, enumSteps) {
  const v = Number(rawValue);
  if (!Number.isFinite(v)) return 0;
  if (kind === PARAM_KIND.ENUM && enumSteps && enumSteps > 1) {
    const max = enumSteps - 1;
    const clamped = Math.max(0, Math.min(max, Math.round(v)));
    return clamped / max;
  }
  if (kind === PARAM_KIND.TOGGLE) {
    return v ? 1 : 0;
  }
  return clampWire(v);
}

// Pick a valueItems label for the current wire value. Returns ""
// when the parameter has no labels or the index is out of range.
export function enumLabelFor(value, valueItems) {
  if (!Array.isArray(valueItems) || valueItems.length === 0) return "";
  const n = valueItems.length;
  const idx = Math.max(0, Math.min(n - 1, Math.round(clampWire(value) * (n - 1))));
  const item = valueItems[idx];
  return item && typeof item.name === "string" ? item.name : "";
}
