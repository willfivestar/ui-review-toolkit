import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewClient } from '../src/next/index.ts';
import { resolveTarget } from '../src/next/targets.ts';

test('typing inside a shadow-root editor never invokes annotation shortcuts', () => {
  const client = Object.create(ReviewClient.prototype);
  let shortcuts = 0;
  Object.assign(client, { open: true, writable: () => true, beginTool: () => shortcuts++, togglePause: () => shortcuts++ });
  const host = { matches: () => false };
  const input = { matches: () => true };
  for (const key of ['e', 'f', 't', 'p']) client.handleKey({ key, target: host, composedPath: () => [input, host] });
  assert.equal(shortcuts, 0);
  client.handleKey({ key: 'p', target: host, composedPath: () => [host] });
  assert.equal(shortcuts, 1);
});

test('closing an edit clears its identity and draft before the next annotation', () => {
  const client = Object.create(ReviewClient.prototype);
  Object.assign(client, { retarget: { id: 'existing' }, draftComment: 'original', draftReplacement: 'replacement', replacementOpen: true, areaStart: {}, areaDrawing: true, restorePause() {}, clearHover() {}, render() {} });
  client.close();
  assert.equal(client.retarget, null);
  assert.equal(client.draftComment, '');
  assert.equal(client.draftReplacement, '');
  assert.equal(client.areaDrawing, false);
});

test('matching selectors on another route cannot produce a verified marker', () => {
  let queried = false;
  const root = { location: { pathname: '/other' }, querySelectorAll: () => { queried = true; return [{}]; } };
  assert.equal(resolveTarget({ route: '/original', selector: '#same' }, root).status, 'other-route');
  assert.equal(queried, false);
  root.location.pathname = '/original';
  assert.equal(resolveTarget({ route: '/original', selector: '#same' }, root).status, 'verified');
});

test('a rejected save preserves the complete editor draft for explicit recovery', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  for (const status of [409, 500]) {
    const client = Object.create(ReviewClient.prototype);
    const draft = { tool: 'text', activeTarget: { selector: '#copy', text: { quote: 'before' } }, draftComment: 'Keep my work', draftReplacement: 'after', retarget: null };
    Object.assign(client, { render() {}, load: async () => {}, data: { session: { revision: 3 }, annotations: [] } });
    await client.mutate({ kind: 'create' }, async () => { throw Object.assign(new Error('Rejected'), { status }); }, draft);
    assert.deepEqual(client.failedDraft, draft);
    assert.match(client.notice, /kept|preserved/i);
  }
});

test('explicit draft recovery uses the current note revision without saving automatically', () => {
  const client = Object.create(ReviewClient.prototype);
  const current = { id: 'note', revision: 8, comment: 'Another reviewer changed this' };
  Object.assign(client, {
    failedDraft: { tool: 'text', activeTarget: { selector: '#copy' }, retarget: { id: 'note', revision: 2 }, draftComment: 'My preserved edit', draftReplacement: 'New words' },
    data: { annotations: [current] }, writable: () => true, beginTool() {}, render() {}, root: { querySelector: () => null },
    mutate() { assert.fail('Recovery must not automatically overwrite the server'); },
  });
  client.restoreDraft();
  assert.equal(client.retarget.revision, 8);
  assert.equal(client.draftComment, 'My preserved edit');
  assert.equal(client.draftReplacement, 'New words');
  assert.equal(client.failedDraft, null);
});

test('an unavailable original note leaves the failed edit intact', () => {
  const client = Object.create(ReviewClient.prototype);
  const draft = { retarget: { id: 'missing' }, draftComment: 'Do not lose me' };
  Object.assign(client, { failedDraft: draft, data: { annotations: [] }, writable: () => true, render() {} });
  client.restoreDraft();
  assert.equal(client.failedDraft, draft);
  assert.match(client.notice, /unavailable/);
});
