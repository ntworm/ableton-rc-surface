// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Tests for Blocker C: Classification and authorization of the 6 transport commands (Task 3.1 / Blocker C)

import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCommand, COMMAND_SIDE_EFFECTS } from "../src/server/command-dispatch.ts";

test("Blocker C: 6 transport commands are correctly classified in COMMAND_SIDE_EFFECTS", () => {
  assert.equal(COMMAND_SIDE_EFFECTS["getTransportLiteState"], "read", "getTransportLiteState must be classified as 'read'");
  assert.equal(COMMAND_SIDE_EFFECTS["refreshTransportLocators"], "live-write", "refreshTransportLocators must be classified as 'live-write'");
  assert.equal(COMMAND_SIDE_EFFECTS["transportStop"], "live-write", "transportStop must be classified as 'live-write'");
  assert.equal(COMMAND_SIDE_EFFECTS["transportToggle"], "live-write", "transportToggle must be classified as 'live-write'");
  assert.equal(COMMAND_SIDE_EFFECTS["transportPrevLocator"], "live-write", "transportPrevLocator must be classified as 'live-write'");
  assert.equal(COMMAND_SIDE_EFFECTS["transportNextLocator"], "live-write", "transportNextLocator must be classified as 'live-write'");
});

test("Blocker C: Controller role CAN execute live-write transport commands", async () => {
  const liveWriteCommands = [
    "refreshTransportLocators",
    "transportStop",
    "transportToggle",
    "transportPrevLocator",
    "transportNextLocator",
  ];

  for (const cmd of liveWriteCommands) {
    const res = await dispatchCommand("controller", { cmd, args: {} });
    // Must NOT be unauthorized (may return ok: true or ok: false due to missing live context, but NOT Unauthorized)
    if (!res.ok) {
      assert.equal(res.error?.includes("Unauthorized"), false, `Controller role MUST be authorized for '${cmd}', got: ${res.error}`);
    }
  }
});

test("Blocker C: Viewer role CAN execute read transport command (getTransportLiteState)", async () => {
  const res = await dispatchCommand("viewer", { cmd: "getTransportLiteState", args: {} });
  if (!res.ok) {
    assert.equal(res.error?.includes("Unauthorized"), false, `Viewer role MUST be authorized for 'getTransportLiteState', got: ${res.error}`);
  }
});

test("Blocker C: Viewer role CANNOT execute live-write transport commands", async () => {
  const liveWriteCommands = [
    "refreshTransportLocators",
    "transportStop",
    "transportToggle",
    "transportPrevLocator",
    "transportNextLocator",
  ];

  for (const cmd of liveWriteCommands) {
    const res = await dispatchCommand("viewer", { cmd, args: {} });
    assert.equal(res.ok, false, `Viewer role MUST NOT execute '${cmd}'`);
    assert.ok(res.error?.includes("Unauthorized"), `Viewer error for '${cmd}' must contain 'Unauthorized'`);
  }
});

test("Blocker C: Admin role CAN execute all transport commands", async () => {
  const allCommands = [
    "getTransportLiteState",
    "refreshTransportLocators",
    "transportStop",
    "transportToggle",
    "transportPrevLocator",
    "transportNextLocator",
  ];

  for (const cmd of allCommands) {
    const res = await dispatchCommand("admin", { cmd, args: {} });
    if (!res.ok) {
      assert.equal(res.error?.includes("Unauthorized"), false, `Admin role MUST be authorized for '${cmd}', got: ${res.error}`);
    }
  }
});
