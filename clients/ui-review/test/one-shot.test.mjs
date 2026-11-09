import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewClient } from '../src/next/index.ts';
import { clampDockPosition } from '../src/next/interaction.ts';

test('E and T activate a one-shot tool from the collapsed launcher', () => {
  for (const [key, expected] of [['e', 'inspect'], ['t', 'text']]) {
    const client = Object.create(ReviewClient.prototype);
    let activated;
    Object.assign(client, { open: false, writable: () => true, beginTool: tool => { activated = tool; } });
    client.handleKey({ key, target: { matches: () => false }, preventDefault() {} });
    assert.equal(activated, expected);
  }
});

test('opening the toolbar does not capture navigation or activate selection', () => {
  const client = Object.create(ReviewClient.prototype);
  Object.assign(client, { tool: null, data: { session: { status: 'open' } }, render() {} });
  client.launch();
  assert.equal(client.open, true);
  assert.equal(client.selectionActive(), false);
});

test('a successful save returns to normal browsing rather than opening Notes', async () => {
  const client = Object.create(ReviewClient.prototype);
  let closed = false;
  Object.assign(client, { data: { session: { revision: 1 }, annotations: [] }, render() {}, close() { closed = true; this.open = false; this.panelOpen = false; } });
  await client.mutate({}, async () => ({ sessionRevision: 2, annotation: { id: 'one' } }));
  assert.equal(closed, true);
  assert.equal(client.panelOpen, false);
  assert.equal(client.save, 'Saved');
});

test('closed or hidden review cannot resurrect markers and target rings', () => {
  for (const state of [{ open: false, markersVisible: true }, { open: true, markersVisible: false }]) {
    const client = Object.create(ReviewClient.prototype);
    Object.assign(client, state, { root: { querySelectorAll: () => [] },
      markerGroups() { assert.fail('Hidden review must not compute or create markers'); },
      data: { annotations: { find() { assert.fail('Hidden review must not resolve saved highlights'); } } },
    });
    client.renderMarkers();
    client.renderTargetRing();
  }
});

test('Layout draft snapshots exclude live DOM references', () => {
  const client = Object.create(ReviewClient.prototype);
  const target = { selector: '#source', layout: { intent: 'rearrange', destinationTarget: { selector: '#destination' } } };
  let saved;
  Object.assign(client, { tool: 'layout', activeTarget: target, draftComment: 'Move this', draftReplacement: '',
    group: [], groupReady: false, retarget: null, data: { session: { revision: 1 } },
    layout: { sourceElement: { uncloneable() {} }, destinationElement: { uncloneable() {} },
      sourceTarget: { selector: '#source' }, destinationTarget: { selector: '#destination' }, instruction: target.layout },
    clearHover() {}, mutate(_operation, _call, draft) { saved = draft; },
  });
  assert.doesNotThrow(() => client.commit());
  assert.equal(saved.layout.sourceElement, undefined);
  assert.equal(saved.layout.destinationElement, undefined);
  assert.equal(saved.layout.destinationTarget.selector, '#destination');
});

test('activation leaves typing, modifiers, composing keys, and open drafts alone', () => {
  for (const override of [{ target: { matches: () => true } }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }]) {
    const client = Object.create(ReviewClient.prototype);
    Object.assign(client, { open: false, writable: () => true, beginTool() { assert.fail('Unexpected activation'); } });
    client.handleKey({ key: 'e', target: { matches: () => false }, ...override });
  }
  const client = Object.create(ReviewClient.prototype);
  Object.assign(client, { open: true, activeTarget: {}, writable: () => true, beginTool() { assert.fail('Do not erase an open draft'); } });
  client.handleKey({ key: 'e', target: { matches: () => false } });
});

test('dock positions clamp after dragging and resizing, including invalid stored values', () => {
  const size = { width: 358, height: 50 };
  const viewport = { width: 390, height: 844 };
  assert.deepEqual(clampDockPosition({ right: -100, bottom: 9999 }, size, viewport), { right: 8, bottom: 786 });
  assert.deepEqual(clampDockPosition({ right: 9999, bottom: -5 }, size, viewport), { right: 24, bottom: 8 });
  assert.deepEqual(clampDockPosition({ right: NaN, bottom: Infinity }, size, viewport), { right: 18, bottom: 18 });
});

test('drag threshold distinguishes clicks and movement, then saves without activating', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { visualViewport: { width: 1000, height: 800, offsetLeft: 0, offsetTop: 0 } };
  try {
    const handlers = {};
    const handle = { addEventListener(type, handler) { handlers[type] = handler; }, setPointerCapture() {} };
    const dock = { offsetWidth: 300, offsetHeight: 50, getBoundingClientRect: () => ({ right: 980, bottom: 780 }) };
    const client = Object.create(ReviewClient.prototype);
    let positioned = 0; let saved = 0; let suppressed = false;
    Object.assign(client, { positionDock() { positioned++; }, saveDockPosition() { saved++; } });
    client.bindDockDrag(handle, dock);
    handlers.pointerdown({ button: 0, pointerId: 1, clientX: 700, clientY: 750 });
    handlers.pointermove({ clientX: 702, clientY: 751 });
    assert.equal(positioned, 0);
    handlers.pointermove({ clientX: 600, clientY: 650, preventDefault() {} });
    assert.deepEqual(client.dockPosition, { right: 120, bottom: 120 });
    handlers.pointerup();
    assert.equal(saved, 1);
    assert.equal(client.draggingDock, false);
    handlers.click({ preventDefault() { suppressed = true; }, stopImmediatePropagation() {} });
    assert.equal(suppressed, true);
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});

test('redrawing saved highlights removes both old Layout rings', () => {
  const client = Object.create(ReviewClient.prototype);
  let removed = 0;
  Object.assign(client, { open: false, root: { querySelectorAll: () => [{ remove() { removed++; } }, { remove() { removed++; } }] } });
  client.renderTargetRing();
  assert.equal(removed, 2);
});

test('Keep annotating starts the next selection only after a successful save', async () => {
  const client = Object.create(ReviewClient.prototype);
  let tool;
  Object.assign(client, { open: true, keepAnnotating: true, data: { session: { revision: 1 }, annotations: [] }, render() {},
    beginTool(value) { tool = value; }, close() { assert.fail('Continuous mode should stay available'); } });
  await client.mutate({}, async () => ({ annotation: { id: 'next' }, sessionRevision: 2 }), { tool: 'text' });
  assert.equal(tool, 'text');
});

test('a late save must not re-arm selection after the reviewer exits', async () => {
  const client = Object.create(ReviewClient.prototype);
  Object.assign(client, { open: true, keepAnnotating: true, data: { session: { revision: 1 }, annotations: [] }, render() {},
    beginTool() { assert.fail('Escape must win over a late save'); }, close() { this.open = false; } });
  await client.mutate({}, async () => { client.open = false; return { annotation: { id: 'late' } }; }, { tool: 'inspect' });
  assert.equal(client.open, false);
});

test('a new shortcut cannot replace the editor while a save is pending', () => {
  const client = Object.create(ReviewClient.prototype);
  Object.assign(client, { save: 'Saving', tool: null, open: false });
  client.beginTool('inspect');
  assert.equal(client.tool, null);
  assert.equal(client.open, false);
});

test('late saves respect Escape even if the reviewer reopens an idle toolbar', async () => {
  const client = Object.create(ReviewClient.prototype);
  Object.assign(client, { open: true, interactionVersion: 1, keepAnnotating: true, data: { session: { revision: 1 }, annotations: [] }, render() {},
    beginTool() { assert.fail('Do not reactivate after Escape'); }, close() { assert.fail('Do not close the newly opened idle toolbar'); } });
  await client.mutate({}, async () => { client.interactionVersion = 2; return { annotation: { id: 'late' } }; }, { tool: 'inspect' });
  assert.equal(client.open, true);
});
