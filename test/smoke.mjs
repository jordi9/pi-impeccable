import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.deepEqual(pkg.pi.extensions, ['./extensions/impeccable.ts']);
assert.ok(pkg.files.includes('CHANGELOG.md'));
assert.equal(pkg.dependencies.impeccable, '*');
assert.equal(fs.existsSync(path.join(root, 'vendor')), false, 'extension should not vendor Impeccable');

const ext = fs.readFileSync(path.join(root, 'extensions/impeccable.ts'), 'utf8');
assert.match(ext, /registerCommand\("impeccable"/);
assert.match(ext, /impeccable_live_reply/);
assert.match(ext, /resources_discover/);
assert.match(ext, /tool_call/);
assert.match(ext, /sendLiveEvent/);
assert.match(ext, /startIndicator/);
assert.match(ext, /setStatus\("impeccable"/);
assert.match(ext, /setStatus\("impeccable-transient"/);
assert.match(ext, /showTransientStatus/);
assert.match(ext, /queued/);
assert.doesNotMatch(ext, /queuedCommandText/);
assert.doesNotMatch(ext, /renderCommandIndicator/);
assert.doesNotMatch(ext, /setInterval/);
assert.match(ext, /!head \|\| head === "help"/);
assert.match(ext, /customType: "impeccable-command"/);
assert.match(ext, /display: false/);
assert.match(ext, /unknownCommandText/);
assert.match(ext, /summarizeLiveStatus/);
assert.match(ext, /if \(\/\\s\/\.test\(trimmedStart\)\) return null/);
assert.doesNotMatch(ext, /sendUserMessage/);
assert.match(ext, /live-poll\\\.mjs/);
assert.match(ext, /impeccable@latest/);
assert.doesNotMatch(ext, /vendor\/impeccable/);

console.log('smoke ok');
