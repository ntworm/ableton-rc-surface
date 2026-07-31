// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Modular command catalog entry point (Task 3.4 / ADR-004)

import type { CommandSpec } from "./types.js";
import { transportCommands } from "./transport-commands.js";

let registeredCommands: Record<string, CommandSpec> = {};

export function registerCatalogCommands(cmds: Record<string, CommandSpec>): void {
  registeredCommands = cmds;
}

function ensureLoaded(): void {
  if (Object.keys(registeredCommands).length === 0) {
    try {
      // Import mappings dynamically if not yet registered
      import("../mappings.js").catch(() => {});
    } catch {}
  }
}

export const commands: Record<string, CommandSpec> = new Proxy(
  {},
  {
    get(_target, prop: string) {
      if (prop in transportCommands) {
        return transportCommands[prop];
      }
      ensureLoaded();
      return registeredCommands[prop];
    },
    ownKeys() {
      ensureLoaded();
      const keys = new Set([
        ...Object.keys(transportCommands),
        ...Object.keys(registeredCommands),
      ]);
      return Array.from(keys);
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      ensureLoaded();
      if (prop in transportCommands || prop in registeredCommands) {
        return { enumerable: true, configurable: true, writable: true };
      }
      return undefined;
    },
    has(_target, prop: string) {
      ensureLoaded();
      return prop in transportCommands || prop in registeredCommands;
    },
  },
);

export type { CommandSpec };
