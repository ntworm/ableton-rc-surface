// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

test('mapping starter templates only reference current phone controls', () => {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(import.meta.dirname, '..', 'admin', 'mappings-core.js'), 'utf8'),
    context
  );
  vm.runInContext(
    fs.readFileSync(path.join(import.meta.dirname, 'templates.js'), 'utf8'),
    context
  );

  const controls = new Set(context.window.phoneControls.flatMap((g) => Array.from(g.items)));
  for (const [templateId, template] of Object.entries(context.window.MappingTemplates)) {
    for (const controlName of Object.keys(template.mappings)) {
      assert.equal(
        controls.has(controlName),
        true,
        `${templateId} references non-canonical control ${controlName}`
      );
    }
  }
});
