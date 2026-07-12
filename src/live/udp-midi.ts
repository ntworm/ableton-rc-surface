// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import * as dgram from "node:dgram";

let udpSocket: dgram.Socket | null = null;
const TARGET_PORT = 9000;
const TARGET_HOST = "127.0.0.1";

export function getUdpSocket(): dgram.Socket {
  if (!udpSocket) {
    udpSocket = dgram.createSocket("udp4");
  }
  return udpSocket;
}

export function sendMidiNote(status: number, note: number, velocity: number): void {
  // Note: no per-call console.log here — this runs in tight loops when
  // trigger_note pads fire. The udp callback below logs send errors only.
  const socket = getUdpSocket();
  const message = Buffer.from([status, note, velocity]); // Standard MIDI byte order: [status, pitch, velocity]
  socket.send(message, 0, message.length, TARGET_PORT, TARGET_HOST, (err) => {
    if (err) {
      console.error(`[ableton-rc-surface] UDP send error:`, err);
    }
  });
}

export function closeUdpSocket(): void {
  if (udpSocket) {
    try {
      udpSocket.close();
    } catch {
      // ignore
    }
    udpSocket = null;
  }
}

const NOTE_OFFSETS: Record<string, number> = {
  "C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
  "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11
};

export function noteNameToMidiNumber(name: string | number | undefined | null): number {
  if (name === undefined || name === null) return 60; // Default C3
  if (typeof name === "number") {
    return Math.max(0, Math.min(127, Math.round(name)));
  }
  const cleaned = name.trim().toUpperCase();
  if (/^\d+$/.test(cleaned)) {
    return Math.max(0, Math.min(127, parseInt(cleaned, 10)));
  }
  const match = cleaned.match(/^([A-G]#?)(-?\d+)$/);
  if (!match) return 60;
  const pitch = match[1];
  const octaveStr = match[2];
  if (!pitch || !octaveStr) return 60;
  const octave = parseInt(octaveStr, 10);
  const offset = NOTE_OFFSETS[pitch] ?? 0;
  return Math.max(0, Math.min(127, (octave + 2) * 12 + offset));
}
