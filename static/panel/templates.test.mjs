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
