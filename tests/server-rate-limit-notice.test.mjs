// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// A rate-limited message returns no reply, which made the limiter invisible:
// from the phone the control just stopped following the finger, with nothing
// in the UI or the log to name the cause. The client now gets told — but at a
// bounded rate, so the notices cannot become the flood they describe.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RATE_NOTICE_INTERVAL_MS,
  createRateLimiter,
  consumeToken,
  takeRateLimitNotice,
} from "../src/server/ws-bounds.ts";

/**
 * Burn the burst bucket and zero the counters, so each test starts from a
 * client that is over budget with nothing yet reported. (The consumeToken call
 * that ends the drain is itself a violation, hence the explicit reset.)
 */
function overBudgetClient() {
  const state = createRateLimiter();
  while (consumeToken(state)) {
    /* burn the bucket */
  }
  state.violations = 0;
  state.noticedViolations = 0;
  return state;
}

function withFrozenClock(fn) {
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    return fn(frozen);
  } finally {
    Date.now = realNow;
  }
}

test("no notice is offered while the client is inside its budget", () => {
  const state = createRateLimiter();
  consumeToken(state);
  assert.equal(takeRateLimitNotice(state), null);
});

test("the first drop of a burst produces a notice carrying the drop count", () => {
  withFrozenClock((now) => {
    const state = overBudgetClient();
    for (let i = 0; i < 5; i++) consumeToken(state);

    const notice = takeRateLimitNotice(state, now);
    assert.ok(notice, "a limited client must be told");
    assert.equal(notice.dropped, 5);
  });
});

test("notices are spaced out and report only new drops", () => {
  withFrozenClock((now) => {
    const state = overBudgetClient();

    for (let i = 0; i < 3; i++) consumeToken(state);
    assert.equal(takeRateLimitNotice(state, now).dropped, 3);

    // Still inside the same window: more drops, but no second notice.
    for (let i = 0; i < 40; i++) consumeToken(state);
    assert.equal(
      takeRateLimitNotice(state, now + RATE_NOTICE_INTERVAL_MS - 1),
      null,
      "notices must not be emitted per dropped message",
    );

    const second = takeRateLimitNotice(state, now + RATE_NOTICE_INTERVAL_MS);
    assert.ok(second, "the next window reports what happened since the last notice");
    assert.equal(second.dropped, 40, "the count is a delta, not a running total");
  });
});

test("a window with no new drops produces no notice", () => {
  withFrozenClock((now) => {
    const state = overBudgetClient();
    consumeToken(state);

    assert.equal(takeRateLimitNotice(state, now).dropped, 1);
    assert.equal(
      takeRateLimitNotice(state, now + RATE_NOTICE_INTERVAL_MS * 5),
      null,
      "silence once the client is back inside its budget",
    );
  });
});
