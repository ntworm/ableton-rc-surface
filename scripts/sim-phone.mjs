// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// sim-phone.mjs — simula um cliente phone mandando data no FORMATO CORRETO
import WS from 'ws';

const ws = new WS('ws://127.0.0.1:8080/ws');
ws.on('open', () => {
  console.log('[SIM] client conectado, mandando data correta a cada 100ms...');
  let i = 0;
  setInterval(() => {
    i++;
    const data = {
      type: 'data',
      client_id: 'sim-phone',
      display_name: 'iPhone do Sim',
      controls: [
        { name: 'fader-1', value: 0.5 + 0.3 * Math.sin(i * 0.3) },
        { name: 'knob-1', value: 0.5 + 0.4 * Math.sin(i * 0.2) },
        { name: 'knob-2', value: 0.5 + 0.4 * Math.cos(i * 0.15) },
        { name: 'pad-1', value: i % 30 < 2 ? 1 : 0 },
      ],
      sensors: {
        motion: 'available',
        orientation: 'available',
        audio: 'active',
        vision: 'active',
        audio_reading: {
          rms: 0.4 + 0.2 * Math.random(),
          pitch: 440,
          bpm: 120,
        },
        vision_reading: {
          hand: { x: 0.5, y: 0.5, z: 0.8, active: true, fist: i % 60 < 5 },
          color: { r: 255, g: 0, b: 0 },
        },
        motion_reading: {
          ax: 0.1 * Math.sin(i * 0.1),
          ay: 0.1 * Math.cos(i * 0.1),
          az: 9.8,
          gx: 0.5 * Math.sin(i * 0.2),
          gy: 0.3 * Math.cos(i * 0.15),
          gz: 0.2,
        },
        orientation_reading: {
          alpha: (i * 2) % 360,
          beta: 30 + 10 * Math.sin(i * 0.05),
          gamma: 20 + 10 * Math.cos(i * 0.05),
        },
        orientation_reading_raw: { alpha: 0, beta: 0, gamma: 0 },
      },
    };
    ws.send(JSON.stringify(data));
  }, 100);
});
ws.on('error', e => console.error('ERR:', e.message));
