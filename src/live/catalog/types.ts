// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// Types for modular command catalog (Task 3.4 / ADR-004)

export type CommandSpec = {
  description: string;
  handler: (args: Record<string, any>) => Promise<any>;
};
