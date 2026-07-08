import dgram from 'node:dgram';
import { TextDecoder, TextEncoder } from 'node:util';
// @ts-ignore
import * as osc from 'osc-min';
import { EventEmitter } from 'node:events';

if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = TextEncoder;
}
if (typeof (globalThis as any).TextDecoder === 'undefined') {
  (globalThis as any).TextDecoder = TextDecoder;
}

export type TransportLiteState = {
  available: boolean;
  connected: boolean;
  error: string | null;
  isPlaying: boolean;
  tempo: number;
  currentSongTimeBeats: number;
  signatureNumerator: number;
  signatureDenominator: number;
  metronome: boolean;
  beat: number;
  locators: Array<{ name: string; time: number }>;
  selectedTrackIndex: number | null;
  selectedDeviceIndex: number | null;
  lastSeenAt: number | null;
};

export class OSCTransport extends EventEmitter {
  private server: dgram.Socket | null = null;
  private client: dgram.Socket | null = null;
  private targetPort: number = 11000;
  private targetHost: string = '127.0.0.1';
  private listenPort: number = 11001;
  private pollInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private requeryOnNextConnection = false;

  public state: TransportLiteState = {
    available: false,
    connected: false,
    error: null,
    isPlaying: false,
    tempo: 120.0,
    currentSongTimeBeats: 0,
    signatureNumerator: 4,
    signatureDenominator: 4,
    metronome: false,
    beat: 0,
    locators: [],
    selectedTrackIndex: null,
    selectedDeviceIndex: null,
    lastSeenAt: null,
  };

  public lastSongTimeUpdateAt: number = Date.now();

  constructor() {
    super();
  }

  public start(): void {
    if (this.server || this.client) {
      return;
    }
    try {
      this.server = dgram.createSocket('udp4');
      this.client = dgram.createSocket('udp4');

      this.server.on('message', (msg) => {
        try {
          const oscMsg = osc.fromBuffer(msg);
          this.handleIncoming(oscMsg);
        } catch (err) {
          // ignore malformed OSC
        }
      });

      this.server.on('error', (err) => {
        this.state.error = err.message;
        this.state.available = false;
        this.state.connected = false;
        this.dispose();
      });

      this.server.bind(this.listenPort, '127.0.0.1', () => {
        this.state.available = true;
        this.state.error = null;
        this.requeryOnNextConnection = true;
        this.queryInitialState();
        this.startPolling();
        this.startHeartbeat();
      });
    } catch (err) {
      this.state.available = false;
      this.state.connected = false;
      this.state.error = err instanceof Error ? err.message : String(err);
      this.dispose();
    }
  }

  public dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
    if (this.client) {
      try { this.client.close(); } catch {}
      this.client = null;
    }
    this.state.available = false;
    this.state.connected = false;
  }

  public send(address: string, args: any[] = []): void {
    if (!this.client) return;
    try {
      const oscMsg = {
        oscType: 'message',
        address,
        args
      };
      const buffer = osc.toBuffer(oscMsg);
      this.client.send(buffer, this.targetPort, this.targetHost, (err) => {
        if (err) {
          this.state.error = err.message;
        }
      });
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
    }
  }

  private handleIncoming(oscMsg: any): void {
    if (oscMsg.oscType !== 'message') return;

    const wasConnected = this.state.connected;
    this.state.connected = true;
    this.state.lastSeenAt = Date.now();
    this.state.error = null;

    if (!wasConnected && this.requeryOnNextConnection) {
      this.requeryOnNextConnection = false;
      this.queryInitialState();
    }

    const address = oscMsg.address;
    const args = oscMsg.args || [];

    let updated = false;

    if (address === '/live/song/get/tempo') {
      const bpm = args[0]?.value;
      if (typeof bpm === 'number') {
        this.state.tempo = bpm;
        updated = true;
      }
    } else if (address === '/live/song/get/is_playing') {
      const val = args[0]?.value;
      const isPlaying = val === 1 || val === true || val === 'true';
      if (this.state.isPlaying !== isPlaying) {
        this.state.isPlaying = isPlaying;
        updated = true;
      }
    } else if (address === '/live/song/get/current_song_time') {
      const time = args[0]?.value;
      if (typeof time === 'number') {
        this.state.currentSongTimeBeats = time;
        this.lastSongTimeUpdateAt = Date.now();
        updated = true;
      }
    } else if (address === '/live/song/get/metronome') {
      const val = args[0]?.value;
      const metronome = val === 1 || val === true || val === 'true';
      if (this.state.metronome !== metronome) {
        this.state.metronome = metronome;
        updated = true;
      }
    } else if (address === '/live/song/get/signature_numerator') {
      const val = args[0]?.value;
      if (typeof val === 'number' && this.state.signatureNumerator !== val) {
        this.state.signatureNumerator = val;
        updated = true;
      }
    } else if (address === '/live/song/get/signature_denominator') {
      const val = args[0]?.value;
      if (typeof val === 'number' && this.state.signatureDenominator !== val) {
        this.state.signatureDenominator = val;
        updated = true;
      }
    } else if (address === '/live/song/get/beat') {
      const val = args[0]?.value;
      if (typeof val === 'number') {
        this.state.beat = val;
        this.emit('beat', val);
        updated = true;
      }
    } else if (address === '/live/song/get/cue_points') {
      const cues: Array<{ name: string; time: number }> = [];
      for (let i = 0; i < args.length; i += 2) {
        const name = args[i]?.value;
        const time = args[i + 1]?.value;
        if (typeof name === 'string' && typeof time === 'number') {
          cues.push({ name, time });
        }
      }
      cues.sort((a, b) => a.time - b.time);
      this.state.locators = cues;
      updated = true;
    } else if (address === '/live/view/get/selected_track') {
      const idx = args[0]?.value;
      if (typeof idx === 'number' && this.state.selectedTrackIndex !== idx) {
        this.state.selectedTrackIndex = idx;
        updated = true;
      }
    } else if (address === '/live/view/get/selected_device') {
      const trackIdx = args[0]?.value;
      const deviceIdx = args[1]?.value;
      if (typeof trackIdx === 'number' && typeof deviceIdx === 'number') {
        if (this.state.selectedTrackIndex !== trackIdx || this.state.selectedDeviceIndex !== deviceIdx) {
          this.state.selectedTrackIndex = trackIdx;
          this.state.selectedDeviceIndex = deviceIdx;
          updated = true;
        }
      }
    }

    if (updated) {
      this.emit('update', this.state);
    }
  }

  private queryInitialState(): void {
    // Register listeners
    this.send('/live/song/start_listen/is_playing');
    this.send('/live/song/start_listen/tempo');
    this.send('/live/song/start_listen/metronome');
    this.send('/live/song/start_listen/signature_numerator');
    this.send('/live/song/start_listen/signature_denominator');
    this.send('/live/song/start_listen/current_song_time');
    this.send('/live/song/start_listen/beat');
    this.send('/live/view/start_listen/selected_track');

    // Get cue points once
    this.send('/live/song/get/cue_points');
  }

  private startPolling(): void {
    this.pollInterval = setInterval(() => {
      // Query things that might not have direct listeners or might have missed updates
      this.send('/live/song/get/tempo');
      this.send('/live/song/get/is_playing');
      this.send('/live/song/get/metronome');
      this.send('/live/view/get/selected_track');
      this.send('/live/view/get/selected_device');
      
      // Also request playhead position if playing, to make sure it's active
      if (this.state.isPlaying) {
        this.send('/live/song/get/current_song_time');
      }
    }, 500);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      // Check for timeout
      if (this.state.lastSeenAt && Date.now() - this.state.lastSeenAt > 3000) {
        this.state.connected = false;
        this.requeryOnNextConnection = true;
      }
      // Send a test ping to see if AbletonOSC is listening
      this.send('/live/song/get/tempo');
    }, 1000);
  }

  // Transport Command Helpers
  public play(): void {
    this.send('/live/song/start_playing');
    this.state.isPlaying = true;
  }

  public stopPlayback(): void {
    this.send('/live/song/stop_playing');
    this.state.isPlaying = false;
  }

  public toggle(): void {
    if (this.state.isPlaying) {
      this.stopPlayback();
    } else {
      this.play();
    }
  }

  public prevLocator(): void {
    this.send('/live/song/jump_to_prev_cue');
  }

  public nextLocator(): void {
    this.send('/live/song/jump_to_next_cue');
  }

  public jumpToLocator(indexOrName: number | string): void {
    if (indexOrName === undefined || indexOrName === null) return;
    const type = typeof indexOrName === 'number' ? 'integer' : 'string';
    this.send('/live/song/cue_point/jump', [{ type, value: indexOrName }]);
  }

  public refreshLocators(): void {
    this.send('/live/song/get/cue_points');
  }
}

// Export singleton instance
export const oscTransport = new OSCTransport();
