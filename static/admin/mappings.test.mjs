import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} function exists`);

  const openBrace = source.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const char = source[i];
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }

  throw new Error(`Could not extract ${name}`);
}

test('admin targetLabel delegates to the shared mapping core with target metadata', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, 'mappings.html'), 'utf8');
  const targetLabelSource = extractFunction(html, 'targetLabel');
  const calls = [];
  const context = {
    result: null,
    targets: [{ trackIndex: 0, name: 'Drums' }],
    window: {
      targetLabel(target, targetsList) {
        calls.push({ target, targetsList });
        return `${targetsList[0].name} -> ${target.type}`;
      },
    },
  };
  vm.createContext(context);

  vm.runInContext(`${targetLabelSource}\nresult = targetLabel({ type: 'mixer_volume', trackIndex: 0 });`, context);

  assert.equal(context.result, 'Drums -> mixer_volume');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].targetsList, context.targets);
});

test('admin shell loads local assets through relative paths', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');

  assert.match(html, /href="style\.css"/);
  assert.match(html, /src="app\.js"/);
  assert.doesNotMatch(html, /(?:href|src)="\/static\/admin\//);
});
