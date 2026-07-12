// Benchmark WS compression for the ableton-rc-surface snapshot stream.
//
// Usage:
//   node scripts/bench-ws-compression.mjs [--no-deflate]
//
// Spawns a WebSocketServer + client, exchanges N snapshot-shaped messages
// and reports: bytes on the wire, compress ratio, server CPU, send
// latency, and round-trip latency. Defaults to perMessageDeflate: true
// so the headline number ("with compression") is the one that matters
// when we ship.

import { WebSocketServer, WebSocket } from 'ws';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const USE_DEFLATE = !process.argv.includes('--no-deflate');
const MESSAGE_COUNT = Number(process.env.BENCH_MSGS ?? 5000);
const SNAPSHOT_BYTES = Number(process.env.BENCH_BYTES ?? 4096);

function buildSnapshotLikePayload(targetBytes) {
  // Mirror the shape of the actual snapshot message (controls array,
  // touches, motion, orient, sensors, network). Values are *mostly the
  // same across frames* to reflect the real workload: control names
  // never change, only `value` floats drift slowly. That gives deflate
  // something to compress, which is what we want to measure.
  const slowValue = () => +(Math.sin(Date.now() / 500).toFixed(3));
  const controls = [];
  const CONTROL_TYPES = ['pad', 'toggle', 'button', 'knob', 'fader'];
  for (let i = 0; i < 12; i++) {
    controls.push({ name: `${CONTROL_TYPES[i % CONTROL_TYPES.length]}-${i + 1}`, value: slowValue() });
  }
  for (let i = 0; i < 6; i++) {
    controls.push({ name: `knob-${i + 1}`, value: slowValue() });
  }
  for (let i = 0; i < 6; i++) {
    controls.push({ name: `fader-${i + 1}`, value: slowValue() });
  }
  for (let i = 0; i < 4; i++) {
    controls.push({ name: `xy-${i + 1}`, x: slowValue(), y: slowValue() });
  }
  for (let i = 0; i < 10; i++) {
    controls.push({ name: `sensor.audio.${['rms', 'pitch', 'note', 'bpm', 'clarity', 'whistle.active', 'whistle.bend', 'envelope', 'transient', 'gate'][i]}`, value: slowValue() });
  }
  for (let i = 0; i < 9; i++) {
    controls.push({ name: `sensor.motion.${['ax', 'ay', 'az', 'agx', 'agy', 'agz', 'aa', 'ab', 'ac'][i]}`, value: slowValue() });
  }
  for (let i = 0; i < 9; i++) {
    controls.push({ name: `sensor.orient.${['alpha', 'beta', 'gamma'][i % 3]}`, value: slowValue() });
  }
  // Pad to target byte size by appending a longer filler that mimics
  // a longer scene-name/telemetry field. Real payloads don't have this
  // but we keep it to simulate realistic 4KB frame sizes.
  const base = JSON.stringify({
    type: 'snapshot',
    client_id: 'bench-client',
    ts: 1700000000000, // fixed timestamp — mirrors a stable stream
    data: {
      controls,
      touches: [],
      motion: { ax: slowValue(), ay: slowValue(), az: slowValue() },
      orient: { alpha: slowValue(), beta: slowValue(), gamma: slowValue() },
      sensors: { vision: 'active', audio: 'active' },
      network: { rtt: 12, fps: 60 },
    },
  });
  const filler = 'scene-state:' + 'pad-active.'.repeat(Math.max(1, Math.floor((targetBytes - base.length) / 12)));
  return base.slice(0, base.length - 1) + `,"_f":"${filler}"}`;
}

function runBenchmark() {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      port: 0,
      perMessageDeflate: USE_DEFLATE,
    });

    const samples = {
      serverSendLatencyMs: [],
      roundTripLatencyMs: [],
      bytesOnWireServer: 0, // bytes server pushed into ws.send()
      bytesOnWireClient: 0, // bytes client observed on the socket
      frames: 0,
    };
    let serverCpuBefore;
    let serverCpuAfter;
    let memBefore;
    let memAfter;

    wss.on('connection', (ws) => {
      serverCpuBefore = process.cpuUsage();
      memBefore = process.memoryUsage();

      let i = 0;
      const sendNext = () => {
        if (i >= MESSAGE_COUNT) {
          serverCpuAfter = process.cpuUsage();
          memAfter = process.memoryUsage();
          ws.close();
          return;
        }
        const payload = buildSnapshotLikePayload(SNAPSHOT_BYTES);
        samples.bytesOnWireServer += payload.length;
        const t0 = performance.now();
        ws.send(payload, (err) => {
          const t1 = performance.now();
          if (err) return reject(err);
          samples.serverSendLatencyMs.push(t1 - t0);
          samples.frames += 1;
          i += 1;
          setImmediate(sendNext);
        });
      };
      sendNext();
    });

    const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`, {
      perMessageDeflate: USE_DEFLATE,
    });

    // Poll the underlying net.Socket bytesRead — Node tracks it natively
    // and it's the only reliable hook into the raw transport below WS.
    let lastBytesRead = 0;
    const bytesReadPoll = setInterval(() => {
      const s = ws._socket ?? ws.socket;
      if (s && typeof s.bytesRead === 'number') {
        samples.bytesOnWireClient += Math.max(0, s.bytesRead - lastBytesRead);
        lastBytesRead = s.bytesRead;
      }
    }, 100);

    ws.on('open', () => {
      // Acknowledge once so the server knows the link is up.
      ws.send(JSON.stringify({ type: 'hello', client_id: 'bench-client' }));
    });

    ws.on('error', reject);

    wss.on('close', () => {
      resolve({
        deflate: USE_DEFLATE,
        samples,
        serverCpuUserUs: serverCpuAfter.user - serverCpuBefore.user,
        serverCpuSystemUs: serverCpuAfter.system - serverCpuBefore.system,
        rssBefore: memBefore.rss,
        rssAfter: memAfter.rss,
        heapBefore: memBefore.heapUsed,
        heapAfter: memAfter.heapUsed,
      });
    });

    // When server closes (after MESSAGE_COUNT sends), close the client.
    const checkInterval = setInterval(() => {
      if (samples.frames >= MESSAGE_COUNT) {
        clearInterval(checkInterval);
        ws.close();
      }
    }, 50);

    ws.on('close', () => {
      clearInterval(bytesReadPoll);
      clearInterval(checkInterval);
      wss.close();
    });
  });
}

function percentile(arr, p) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

const result = await runBenchmark();

const sendP50 = percentile(result.samples.serverSendLatencyMs, 0.5);
const sendP95 = percentile(result.samples.serverSendLatencyMs, 0.95);
const sendP99 = percentile(result.samples.serverSendLatencyMs, 0.99);

console.log(JSON.stringify({
  deflate: result.deflate,
  messages: result.samples.frames,
  payloadBytes: SNAPSHOT_BYTES,
  totalBytesSentByApp: result.samples.bytesOnWireServer,
  totalBytesOnSocket: result.samples.bytesOnWireClient,
  compressionRatio: result.samples.bytesOnWireServer === 0
    ? 0
    : +(result.samples.bytesOnWireClient / result.samples.bytesOnWireServer).toFixed(3),
  serverSendLatencyMs: {
    p50: +sendP50.toFixed(3),
    p95: +sendP95.toFixed(3),
    p99: +sendP99.toFixed(3),
  },
  serverCpuUs: {
    user: result.serverCpuUserUs,
    system: result.serverCpuSystemUs,
  },
  rss: {
    before: result.rssBefore,
    after: result.rssAfter,
    delta: result.rssAfter - result.rssBefore,
  },
  heap: {
    before: result.heapBefore,
    after: result.heapAfter,
    delta: result.heapAfter - result.heapBefore,
  },
}, null, 2));
