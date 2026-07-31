// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { setExtensionContext, clearExtensionContext } from '../src/context.ts';
import { commands } from '../src/live/mappings.ts';

test.afterEach(() => clearExtensionContext());

test('getTargets stays usable when Live omits optional track collections', async () => {
  setExtensionContext({
    application: { song: { tempo: 120, mainTrack: null, returnTracks: [] } },
  });

  const result = await commands.getTargets.handler({});
  assert.deepEqual(result.targets, [
    { id: 'tempo', type: 'tempo', label: 'Song Tempo (120.0 BPM)' },
  ]);
});
