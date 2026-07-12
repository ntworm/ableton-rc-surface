// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
// src/runtime/global-polyfill.ts
//
// Ableton Live extension host runs each extension in a strict VM where
// `global` is not defined as an identifier (Node 22+ uses `globalThis`
// instead). Bundles authored against the Node 18 `global` symbol crash
// with "ReferenceError: global is not defined" the moment the bundler
// touches a __require shim or a third-party module that calls
// `typeof global !== "undefined"` during evaluation.
//
// This module defines `global` as an alias for `globalThis` at module
// scope so any deep require() or lazy third-party probe sees the
// identifier in scope rather than throwing ReferenceError.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gt = globalThis as any;

if (typeof gt.global === "undefined") {
  Object.defineProperty(gt, "global", {
    value: gt,
    writable: false,
    configurable: true,
    enumerable: false,
  });
}

if (typeof gt.crypto === "undefined") {
  Object.defineProperty(gt, "crypto", {
    value: undefined,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export {};
