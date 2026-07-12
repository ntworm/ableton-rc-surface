// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import assert from "node:assert/strict";
import test from "node:test";
import dgram from "node:dgram";
// @ts-ignore
import * as osc from 'osc-min';
import { OSCTransport } from "../src/live/osc-transport.ts";

test("OSCTransport state is updated correctly by incoming OSC messages", () => {
  const transport = new OSCTransport();

  // Initially connected is false
  assert.equal(transport.state.connected, false);

  // Simulate incoming tempo message
  const tempoMsg = osc.toBuffer({
    oscType: "message",
    address: "/live/song/get/tempo",
    args: [{ type: "float", value: 125.5 }]
  });
  
  // @ts-ignore (call private method for testing)
  transport.handleIncoming(osc.fromBuffer(tempoMsg));

  assert.equal(transport.state.connected, true);
  assert.equal(transport.state.tempo, 125.5);

  // Simulate is_playing message
  const playMsg = osc.toBuffer({
    oscType: "message",
    address: "/live/song/get/is_playing",
    args: [{ type: "integer", value: 1 }]
  });
  // @ts-ignore
  transport.handleIncoming(osc.fromBuffer(playMsg));
  assert.equal(transport.state.isPlaying, true);

  // Simulate signature message
  const sigNumMsg = osc.toBuffer({
    oscType: "message",
    address: "/live/song/get/signature_numerator",
    args: [{ type: "integer", value: 3 }]
  });
  // @ts-ignore
  transport.handleIncoming(osc.fromBuffer(sigNumMsg));
  assert.equal(transport.state.signatureNumerator, 3);

  // Simulate current song time
  const timeMsg = osc.toBuffer({
    oscType: "message",
    address: "/live/song/get/current_song_time",
    args: [{ type: "float", value: 16.5 }]
  });
  const prevUpdateAt = transport.lastSongTimeUpdateAt;
  // @ts-ignore
  transport.handleIncoming(osc.fromBuffer(timeMsg));
  assert.equal(transport.state.currentSongTimeBeats, 16.5);
  assert.ok(transport.lastSongTimeUpdateAt >= prevUpdateAt);
});

test("OSCTransport starts and stops without crash", async () => {
  const transport = new OSCTransport();
  
  // Start transport
  transport.start();
  
  // Wait a small bit for bind
  await new Promise((resolve) => setTimeout(resolve, 50));
  
  // Stop transport
  transport.dispose();
  assert.equal(transport.state.available, false);
  assert.equal(transport.state.connected, false);
});

test("OSCTransport handles occupied port gracefully without crashing", async () => {
  // Bind another socket to port 11001 first
  const occupier = dgram.createSocket("udp4");
  await new Promise((resolve) => {
    occupier.on("error", () => {
      resolve();
    });
    occupier.bind(11001, "127.0.0.1", () => {
      resolve();
    });
  });

  const transport = new OSCTransport();
  
  // Try starting the transport (it should fail to bind but not crash)
  transport.start();
  
  // Wait for error event or setTimeout
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(transport.state.available, false);
  assert.ok(transport.state.error !== null);

  // Cleanup
  transport.dispose();
  await new Promise((resolve) => {
    try {
      occupier.close(resolve);
    } catch {
      resolve();
    }
  });
});

test("OSCTransport stopPlayback changes isPlaying state but keeps socket open", async () => {
  const transport = new OSCTransport();
  
  // Start transport
  transport.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  
  const wasAvailable = transport.state.available;
  transport.state.isPlaying = true;
  transport.stopPlayback();
  
  assert.equal(transport.state.isPlaying, false);
  assert.equal(transport.state.available, wasAvailable); // Available state is unchanged
  
  transport.dispose();
});
