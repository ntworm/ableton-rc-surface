// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import { type initialize } from "@ableton-extensions/sdk";

export type ExtensionContext = ReturnType<typeof initialize>;

let extensionContext: ExtensionContext | null = null;

export function getExtensionContext(): ExtensionContext | null {
  return extensionContext;
}

export function setExtensionContext(ctx: ExtensionContext): void {
  extensionContext = ctx;
}

export function clearExtensionContext(): void {
  extensionContext = null;
}

export function requireCtx() {
  if (!extensionContext) throw new Error("extension context not ready");
  const song = extensionContext.application.song;
  if (!song) throw new Error("no song loaded");
  return { context: extensionContext, song };
}

export function requireTrack(song: ReturnType<typeof requireCtx>["song"], index: unknown) {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= song.tracks.length) {
    throw new Error(`invalid track index: ${String(index)} (have ${song.tracks.length} tracks)`);
  }
  const track = song.tracks[index];
  if (!track) throw new Error(`no track at index ${index}`);
  return track;
}
