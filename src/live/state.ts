import { getExtensionContext } from "../context.js";
import { trackedClients } from "../server/ws.js";

export let playheadActive = false;
export let playheadStartTime = 0;
export let playheadBaseTimeMs = 0;
export let lastBroadcastedState = { tempo: 0, signature: "", scale: "" };

export function setPlayheadActive(val: boolean) { playheadActive = val; }
export function setPlayheadStartTime(val: number) { playheadStartTime = val; }
export function setPlayheadBaseTimeMs(val: number) { playheadBaseTimeMs = val; }

export const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function getScaleLabel(root: number, name: string): string {
  const noteName = NOTES[root] ?? "";
  return noteName ? `${noteName} ${name}` : name;
}

export function broadcastPlayheadState(): void {
  const now = Date.now();
  const currentPos = playheadActive ? (playheadBaseTimeMs + (now - playheadStartTime)) : playheadBaseTimeMs;
  const payload = {
    type: "playhead_state",
    playheadActive,
    playheadTimeMs: currentPos,
  };
  const json = JSON.stringify(payload);
  for (const c of trackedClients.values()) {
    if (!c.isAdmin && c.ws.readyState === c.ws.OPEN) {
      try {
        c.ws.send(json);
      } catch {}
    }
  }
}

export function checkAndBroadcastLiveState(): void {
  try {
    const extensionContext = getExtensionContext();
    if (!extensionContext) return;
    const song = extensionContext.application.song;
    if (!song) return;

    const tempo = song.tempo;
    
    let signature = "4/4";
    if (song.scenes && song.scenes.length > 0 && song.scenes[0]) {
      const scene = song.scenes[0];
      signature = `${scene.signatureNumerator}/${scene.signatureDenominator}`;
    }

    const scale = getScaleLabel(song.rootNote, song.scaleName);

    if (
      tempo !== lastBroadcastedState.tempo ||
      signature !== lastBroadcastedState.signature ||
      scale !== lastBroadcastedState.scale
    ) {
      lastBroadcastedState = { tempo, signature, scale };
      const payload = { type: "live_state", tempo, signature, scale };
      const json = JSON.stringify(payload);
      for (const c of trackedClients.values()) {
        if (!c.isAdmin && c.ws.readyState === c.ws.OPEN) {
          try {
            c.ws.send(json);
          } catch {}
        }
      }
    }
  } catch (err) {
    // ignore
  }
}
