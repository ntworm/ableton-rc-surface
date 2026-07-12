// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { clearExtensionContext, setExtensionContext } from "../src/context.ts";
import { adminSockets, trackedClients } from "../src/server/ws.ts";
import { oscTransport } from "../src/live/osc-transport.ts";
import {
  activeSmooths,
  clearHostModulatorsForClient,
  controlMappings,
  eventModesState,
  hostModulators,
  lastMappedValues,
  stopHostModulatorLoop,
  tickHostModulators,
  updateHostModulator,
} from "../src/live/mappings.ts";

function resetState() {
  stopHostModulatorLoop();
  controlMappings.clear();
  lastMappedValues.clear();
  activeSmooths.clear();
  eventModesState.clear();
  hostModulators.clear();
  trackedClients.clear();
  adminSockets.clear();
  oscTransport.state.available = false;
  oscTransport.state.connected = false;
  oscTransport.state.isPlaying = false;
  oscTransport.state.currentSongTimeBeats = 0;
  oscTransport.lastSongTimeUpdateAt = Date.now();
  clearExtensionContext();
}

function setupMappedParam(controlName) {
  const applied = [];
  const param = {
    min: 0,
    max: 1,
    setValue(value) {
      applied.push(value);
    },
  };

  setExtensionContext({
    application: {
      song: {
        tempo: 120,
        tracks: [
          {
            devices: [
              {
                parameters: [param],
              },
            ],
          },
        ],
      },
    },
  });
  controlMappings.set(controlName, [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 },
  ]);

  return applied;
}

function setupTrackedClient(id = "client-1") {
  trackedClients.set(id, {
    id,
    ipAddress: "127.0.0.1",
    displayName: "phone",
    isAdmin: false,
    mode: "performance",
    path: "/ws",
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    userAgent: "test",
    lastData: null,
    history: {},
    ws: { readyState: WebSocket.OPEN },
  });
}

test("host LFO motor generates mapped values from modulator state", async () => {
  resetState();
  const applied = setupMappedParam("toggle-1");

  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 1,
      depth: 1,
      syncMode: "free",
    });

    await tickHostModulators(0);
    await tickHostModulators(25);

    assert.deepEqual(applied.map((v) => Number(v.toFixed(6))), [0, 1]);
  } finally {
    resetState();
  }
});

test("host LFO motor publishes generated values to the admin panel feed", async () => {
  resetState();
  setupMappedParam("toggle-1");
  const adminMessages = [];
  const adminSocket = {
    readyState: WebSocket.OPEN,
    send(message) {
      adminMessages.push(JSON.parse(message));
    },
  };
  adminSockets.add(adminSocket);
  setupTrackedClient();

  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 1,
      depth: 1,
      syncMode: "free",
    });

    await tickHostModulators(0);

    const latestUpdate = adminMessages.findLast((msg) => msg.type === "client_update");
    assert.ok(latestUpdate, "expected host-generated values to notify admin clients");
    assert.equal(latestUpdate.client.client_id, "client-1");
    assert.equal(latestUpdate.latest.controls.at(-1).name, "toggle-1");
    assert.equal(latestUpdate.latest.controls.at(-1).value, 0);
    assert.equal(latestUpdate.history["toggle-1"].at(-1)[1], 0);
  } finally {
    resetState();
  }
});

test("host LFO motor interpolates morph targets without per-frame phone updates", async () => {
  resetState();
  setupMappedParam("toggle-1");

  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 0.2,
      depth: 0.2,
      syncMode: "free",
    });
    await tickHostModulators(0);

    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 0.8,
      depth: 1,
      syncMode: "free",
      morphMs: 1000,
    });
    await tickHostModulators(500);

    const state = hostModulators.get("client-1::toggle-1");
    assert.ok(state, "expected active host LFO state");
    assert.ok(state.rate > 0.45 && state.rate < 0.55, `expected interpolated rate, got ${state.rate}`);
    assert.ok(state.depth > 0.55 && state.depth < 0.65, `expected interpolated depth, got ${state.depth}`);

    await tickHostModulators(1000);

    assert.equal(Number(state.rate.toFixed(3)), 0.8);
    assert.equal(Number(state.depth.toFixed(3)), 1);
  } finally {
    resetState();
  }
});

test("host synced LFO applies updated shape while already active", async () => {
  resetState();
  const applied = setupMappedParam("toggle-1");
  oscTransport.state.available = true;
  oscTransport.state.connected = true;
  oscTransport.state.isPlaying = true;
  oscTransport.state.currentSongTimeBeats = 0;
  oscTransport.lastSongTimeUpdateAt = 0;

  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 0.5,
      depth: 1,
      syncMode: "sync",
      clockSource: "osc",
      syncSubdivisionBeats: 4,
      shape: "sine",
    });
    await tickHostModulators(0);

    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 0.5,
      depth: 1,
      syncMode: "sync",
      clockSource: "osc",
      syncSubdivisionBeats: 4,
      shape: "square",
    });
    await tickHostModulators(0);

    assert.equal(applied.at(-2), 0.5);
    assert.equal(applied.at(-1), 1);
    assert.equal(hostModulators.get("client-1::toggle-1")?.shape, "square");
  } finally {
    resetState();
  }
});

test("host LFO morph keeps active until inactive target completes", async () => {
  resetState();
  const applied = setupMappedParam("toggle-1");

  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 0.5,
      depth: 0.7,
      syncMode: "free",
    });
    await tickHostModulators(0);

    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: false,
      rate: 0.5,
      depth: 0,
      syncMode: "free",
      morphMs: 1000,
    });
    await tickHostModulators(500);

    assert.ok(hostModulators.has("client-1::toggle-1"), "inactive morph should keep host LFO alive mid-transition");

    await tickHostModulators(1000);

    assert.equal(hostModulators.has("client-1::toggle-1"), false);
    assert.equal(applied.at(-1), 0);
  } finally {
    resetState();
  }
});

test("host LFO motor applies to Live before publishing admin panel updates", async () => {
  resetState();
  const events = [];
  const param = {
    min: 0,
    max: 1,
    setValue(value) {
      events.push(["live", value]);
    },
  };

  setExtensionContext({
    application: {
      song: {
        tempo: 120,
        tracks: [
          {
            devices: [
              {
                parameters: [param],
              },
            ],
          },
        ],
      },
    },
  });
  controlMappings.set("toggle-1", [
    { type: "device_param", trackIndex: 0, deviceIndex: 0, paramIndex: 0 },
  ]);
  adminSockets.add({
    readyState: WebSocket.OPEN,
    send() {
      events.push(["admin"]);
    },
  });
  setupTrackedClient();

  try {
    updateHostModulator("client-1", {
      kind: "lfo",
      name: "toggle-1",
      active: true,
      rate: 1,
      depth: 1,
      syncMode: "free",
    });

    await tickHostModulators(0);

    assert.equal(events[0][0], "live");
    assert.equal(events[1][0], "admin");
  } finally {
    resetState();
  }
});

test("host stutter motor generates mapped pulses from modulator state", async () => {
  resetState();
  const applied = setupMappedParam("button-1");

  try {
    updateHostModulator("client-1", {
      kind: "stutter",
      name: "button-1",
      active: true,
      rate: 1,
      count: 1,
      syncMode: "free",
    });

    await tickHostModulators(0);
    await tickHostModulators(40);

    assert.deepEqual(applied, [1, 0]);
  } finally {
    resetState();
  }
});

test("clearing a client stops host modulators and sends a final zero", async () => {
  resetState();
  const applied = setupMappedParam("button-1");

  try {
    updateHostModulator("client-1", {
      kind: "stutter",
      name: "button-1",
      active: true,
      rate: 1,
      count: 1,
      syncMode: "free",
    });

    clearHostModulatorsForClient("client-1");

    assert.equal(hostModulators.size, 0);
    assert.equal(applied.at(-1), 0);
  } finally {
    resetState();
  }
});
