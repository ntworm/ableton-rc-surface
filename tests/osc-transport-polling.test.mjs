// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// queryInitialState registers `start_listen` for tempo, is_playing, metronome,
// both signature halves, current_song_time, beat and selected_track —
// AbletonOSC pushes every one of those on change. The 500 ms poll used to ask
// for the same values anyway, and the 2 s heartbeat asked for the tempo a
// third time. That was ~12 OSC messages a second out and as many replies back,
// forever, restating what had just been pushed — and every reply walks
// handleIncoming and can emit an 'update' to all connected phones.
//
// Polling is now a recovery path: it runs when the push stream goes quiet.
import test from "node:test";
import assert from "node:assert/strict";
import { OSCTransport, LISTENER_QUIET_MS } from "../src/live/osc-transport.ts";

function recordingTransport() {
  const transport = new OSCTransport();
  const sent = [];
  transport.send = (address) => sent.push(address);
  return { transport, sent };
}

test("a flowing push stream reduces polling to what has no listener behind it", () => {
  const { transport, sent } = recordingTransport();
  const now = Date.now();
  transport.state.lastSeenAt = now - 100; // a push arrived 100 ms ago
  transport.state.isPlaying = true;

  transport.pollTick(now);

  assert.deepEqual(
    sent,
    ["/live/view/get/selected_device"],
    "selected_device is the only value with no start_listen behind it",
  );
});

test("a quiet push stream falls back to a full resync", () => {
  const { transport, sent } = recordingTransport();
  const now = Date.now();
  transport.state.lastSeenAt = now - (LISTENER_QUIET_MS + 1);
  transport.state.isPlaying = true;

  transport.pollTick(now);

  assert.ok(sent.includes("/live/song/get/tempo"));
  assert.ok(sent.includes("/live/song/get/is_playing"));
  assert.ok(sent.includes("/live/song/get/metronome"));
  assert.ok(sent.includes("/live/view/get/selected_track"));
  assert.ok(
    sent.includes("/live/song/get/current_song_time"),
    "the playhead is only re-asked for while playing",
  );
});

test("a quiet stream that is not playing does not ask for the playhead", () => {
  const { transport, sent } = recordingTransport();
  const now = Date.now();
  transport.state.lastSeenAt = now - (LISTENER_QUIET_MS + 1);
  transport.state.isPlaying = false;

  transport.pollTick(now);

  assert.ok(!sent.includes("/live/song/get/current_song_time"));
});

test("the heartbeat probe is skipped while the link is already proving itself", () => {
  const { transport, sent } = recordingTransport();
  const now = Date.now();
  transport.state.lastSeenAt = now - 200;

  transport.heartbeatTick(now);

  assert.deepEqual(sent, [], "anything arriving on the socket already proves liveness");
});

test("the heartbeat probes once the stream goes quiet", () => {
  const { transport, sent } = recordingTransport();
  const now = Date.now();
  transport.state.lastSeenAt = now - (LISTENER_QUIET_MS + 1);

  transport.heartbeatTick(now);

  assert.deepEqual(sent, ["/live/song/get/tempo"]);
});

test("disconnect detection still fires after five silent seconds", () => {
  const { transport } = recordingTransport();
  const now = Date.now();
  transport.state.lastSeenAt = now - 5001;
  transport.state.connected = true;

  transport.heartbeatTick(now);

  assert.equal(transport.state.connected, false);
});

test("a socket that never spoke is treated as quiet, not as connected", () => {
  const { transport, sent } = recordingTransport();
  const now = Date.now();
  transport.state.lastSeenAt = null;
  transport.state.connected = true;

  transport.heartbeatTick(now);

  assert.equal(transport.state.connected, true, "no first message yet is not a disconnect");
  assert.deepEqual(sent, ["/live/song/get/tempo"], "but it must still be probed");
});

test("steady-state traffic drops by roughly an order of magnitude", () => {
  const { transport, sent } = recordingTransport();
  const now = Date.now();
  transport.state.isPlaying = true;

  // Ten seconds of playback: 20 poll turns, 5 heartbeat turns, with
  // current_song_time pushing throughout so the stream never goes quiet.
  for (let i = 0; i < 20; i++) {
    transport.state.lastSeenAt = now + i * 500;
    transport.pollTick(now + i * 500);
  }
  for (let i = 0; i < 5; i++) {
    transport.state.lastSeenAt = now + i * 2000;
    transport.heartbeatTick(now + i * 2000);
  }

  // Was 20 * 6 + 5 = 125 messages for the same ten seconds.
  assert.equal(sent.length, 20, "only the listener-less selection query survives");
});
