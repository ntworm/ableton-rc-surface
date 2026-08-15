// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Mappings used to be keyable per phone (`<uuid>::fader-1`) as well as
// globally (`fader-1`). That is what made the panel unable to say which phone
// a binding belonged to, and it makes no sense at all once the surface is
// shared: `fader-1` has to mean one thing no matter who touches it.
//
// Legacy keys are folded into their global control on load. Where a global
// binding already exists it wins — it is the one the panel has been showing —
// and the discarded per-phone binding is reported rather than dropped in
// silence, because losing a mapping without being told is how a set goes wrong
// on stage.
import test from "node:test";
import assert from "node:assert/strict";
import { migrateLegacyClientMappings } from "../src/live/project-config.ts";

const PHONE_A = "11111111-2222-4333-8444-555555555555";
const PHONE_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("a per-phone key collapses onto its control name", () => {
  const result = migrateLegacyClientMappings({
    [`${PHONE_A}::fader-1`]: [{ type: "tempo" }],
  });

  assert.deepEqual(Object.keys(result.mappings), ["fader-1"]);
  assert.equal(result.migrated, 1);
  assert.deepEqual(result.conflicts, []);
});

test("global keys are left exactly as they are", () => {
  const targets = [{ type: "mixer_volume", trackIndex: 2 }];
  const result = migrateLegacyClientMappings({ "knob-3": targets });

  assert.equal(result.mappings["knob-3"], targets);
  assert.equal(result.migrated, 0);
});

test("an existing global binding wins over a per-phone one", () => {
  const globalTargets = [{ type: "tempo" }];
  const phoneTargets = [{ type: "mixer_pan", trackIndex: 7 }];
  const result = migrateLegacyClientMappings({
    "fader-1": globalTargets,
    [`${PHONE_A}::fader-1`]: phoneTargets,
  });

  assert.equal(result.mappings["fader-1"], globalTargets, "the binding the panel showed stays");
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0], /fader-1/);
});

test("two phones bound to the same control: the first wins and the other is reported", () => {
  const first = [{ type: "tempo" }];
  const second = [{ type: "track_mute", trackIndex: 1 }];
  const result = migrateLegacyClientMappings({
    [`${PHONE_A}::pad-2`]: first,
    [`${PHONE_B}::pad-2`]: second,
  });

  assert.equal(result.mappings["pad-2"], first);
  assert.equal(result.conflicts.length, 1, "the performer has to be told one was dropped");
  assert.match(result.conflicts[0], /pad-2/);
});

test("a control name that merely contains :: is not treated as a phone key", () => {
  // Only a real UUID prefix is legacy. Anything else is a control name and
  // must survive untouched.
  const targets = [{ type: "tempo" }];
  const result = migrateLegacyClientMappings({ "weird::name": targets });

  assert.equal(result.mappings["weird::name"], targets);
  assert.equal(result.migrated, 0);
});

test("junk input does not throw", () => {
  assert.deepEqual(migrateLegacyClientMappings(null).mappings, {});
  assert.deepEqual(migrateLegacyClientMappings(undefined).mappings, {});
  assert.deepEqual(migrateLegacyClientMappings("nonsense").mappings, {});
});

test("mixed sets keep every distinct control", () => {
  const result = migrateLegacyClientMappings({
    "pad-1": [{ type: "tempo" }],
    [`${PHONE_A}::knob-1`]: [{ type: "mixer_volume", trackIndex: 0 }],
    [`${PHONE_B}::knob-2`]: [{ type: "mixer_pan", trackIndex: 0 }],
  });

  assert.deepEqual(Object.keys(result.mappings).sort(), ["knob-1", "knob-2", "pad-1"]);
  assert.equal(result.migrated, 2);
  assert.deepEqual(result.conflicts, []);
});
