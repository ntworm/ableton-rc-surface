// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import test from "node:test";
import assert from "node:assert/strict";
import { stripWslDrivePrefix } from "../src/util/helpers.js";

test("stripWslDrivePrefix handles normal, WSL and Win32 UNC/long paths", () => {
  // Win32 regular path
  assert.equal(stripWslDrivePrefix("C:\\Users\\foo"), "C:\\Users\\foo");
  
  // WSL/leading slash path
  assert.equal(stripWslDrivePrefix("/C:/Users/foo"), "C:/Users/foo");

  // Win32 long path (\\\\?\\)
  assert.equal(stripWslDrivePrefix("\\\\?\\C:\\Users\\foo"), "C:\\Users\\foo");

  // Win32 UNC long path (\\\\?\\UNC\\)
  assert.equal(stripWslDrivePrefix("\\\\?\\UNC\\server\\share"), "\\\\server\\share");
});

test("step function returns resolved value on success", async () => {
  const { step } = await import("../src/util/helpers.js");
  const res = await step("successCall", async () => 42);
  assert.equal(res, 42);
});

test("step function wraps standard Error rejection", async () => {
  const { step } = await import("../src/util/helpers.js");
  await assert.rejects(
    async () => {
      await step("failCall", async () => {
        throw new Error("inner error");
      });
    },
    /step "failCall" failed: inner error/
  );
});

test("step function wraps undefined rejection", async () => {
  const { step } = await import("../src/util/helpers.js");
  await assert.rejects(
    async () => {
      await step("undefinedCall", async () => {
        throw undefined;
      });
    },
    /step "undefinedCall" failed: <undefined>/
  );
});

