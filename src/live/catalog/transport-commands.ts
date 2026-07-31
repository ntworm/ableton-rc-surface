// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Transport command catalog (Task 3.4 / ADR-004)

import { oscTransport } from "../osc-transport.js";
import type { CommandSpec } from "./types.js";

export const transportCommands: Record<string, CommandSpec> = {
  getTransportLiteState: {
    description: "Get current Transport Lite state from AbletonOSC",
    handler: async () => {
      return oscTransport.state;
    },
  },
  refreshTransportLocators: {
    description: "Refresh locator list from AbletonOSC",
    handler: async () => {
      oscTransport.refreshLocators();
      return { ok: true };
    },
  },
  transportPlay: {
    description: "Start playback via AbletonOSC",
    handler: async () => {
      oscTransport.play();
      return { ok: true };
    },
  },
  transportStop: {
    description: "Stop playback via AbletonOSC",
    handler: async () => {
      oscTransport.stopPlayback();
      return { ok: true };
    },
  },
  transportToggle: {
    description: "Toggle playback via AbletonOSC",
    handler: async () => {
      oscTransport.toggle();
      return { ok: true };
    },
  },
  transportPrevLocator: {
    description: "Jump to previous locator",
    handler: async () => {
      oscTransport.prevLocator();
      return { ok: true };
    },
  },
  transportNextLocator: {
    description: "Jump to next locator",
    handler: async () => {
      oscTransport.nextLocator();
      return { ok: true };
    },
  },
  transportJumpToLocator: {
    description: "Jump to a specific locator",
    handler: async (args) => {
      const indexOrName = args["indexOrName"];
      if (indexOrName !== undefined && indexOrName !== null) {
        oscTransport.jumpToLocator(indexOrName);
      }
      return { ok: true };
    },
  },
};
