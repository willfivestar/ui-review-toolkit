import assert from "node:assert/strict";
import test from "node:test";
import { ReviewClient } from "../src/next/index.ts";

function client(extra = {}) {
  return Object.assign(Object.create(ReviewClient.prototype), {
    open: true, tool: null, previewMode: "original", notePreview: null,
    data: { session: { status: "open", revision: 1 }, annotations: [] },
    render() {}, clearHover() {}, restorePause() {},
  }, extra);
}
function globals(values, run) {
  const originals = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try { return run(); }
  finally { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
}
function notes() {
  return [
    { id: "a", target: { text: { quote: "Old" }, suggestion: { before: "Old", after: "New" } } },
    { id: "b", target: { text: { quote: "Second" }, suggestion: { before: "Second", after: "Updated" } } },
    { id: "comment", target: { selector: "#comment" } },
  ];
}

test("a fully deleted text node never places its marker at a spurious zero rectangle", () => {
  const element = {};
  const c = client({ previewStatuses: new Map([["a", "applied"]]), textPreview: {
    resolve: () => ({ status: "verified", element }),
    displayedRange: () => ({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }) }),
  } });
  const result = c.resolve({});
  assert.equal(result.textRect, null);
  assert.equal(result.element, element);
  assert.equal(result.textPreviewActive, true);
});

test("new clients start Original even if a prior local preference says Proposed", () => globals({
  document: { activeElement: null }, window: { location: { origin: "https://preview.test" } },
  sessionStorage: { getItem() { return null; } }, location: { href: "https://preview.test/page" },
  localStorage: { getItem: () => "proposed" },
}, () => {
  const c = new ReviewClient({ sessionId: "s", endpoint: "https://api.test", fetchImpl() {} });
  assert.equal(c.previewMode, "original"); assert.equal(c.notePreview, null); assert.equal(c.open, false);
}));

test("page comparison affects all suggestions while a note comparison overrides only that note", () => {
  const c = client(); c.data.annotations = notes();
  assert.deepEqual(c.previewItems(), []);
  c.setPreviewMode("proposed"); assert.deepEqual(c.previewItems().map((item) => item.id), ["a", "b"]);
  c.notePreview = { id: "a", mode: "original" }; assert.deepEqual(c.previewItems().map((item) => item.id), ["b"]);
  c.setPreviewMode("original"); assert.equal(c.notePreview, null);
  c.notePreview = { id: "b", mode: "proposed" }; assert.deepEqual(c.previewItems().map((item) => item.id), ["b"]);
  c.open = false; assert.deepEqual(c.previewItems(), []);
});

test("selection suspends saved previews without forgetting the explicit page preference", () => globals({ document: { activeElement: null } }, () => {
  let restored = 0;
  const c = client({ previewMode: "proposed", notePreview: { id: "a", mode: "proposed" }, shadow: { activeElement: null }, textPreview: { restore() { restored++; } } });
  c.data.annotations = notes();
  c.beginTool("text");
  assert.equal(restored, 1); assert.equal(c.previewMode, "proposed"); assert.equal(c.notePreview, null);
  assert.equal(c.tool, "text"); assert.deepEqual(c.previewItems(), []);
}));

test("inline suggestion-only saves preserve replacement whitespace and explicit deletion", () => {
  for (const replacement of ["New wording", "  leading and trailing  ", ""]) {
    let saved;
    const c = client({ tool: "text", activeTarget: { selector: "#p", text: { quote: "Original" } },
      draftComment: "", draftReplacement: replacement, replacementOpen: true, group: [], layout: null,
      mutate(operation) { saved = operation; },
    });
    c.commit();
    assert.equal(saved.annotation.comment, "Suggested text change");
    assert.deepEqual(saved.annotation.target.suggestion, { before: "Original", after: replacement });
    assert.equal(c.activeTarget, null); assert.equal(c.tool, null); assert.equal(c.replacementOpen, false);
  }
});

test("unchanged inline wording needs a comment and ordinary text notes remain supported", () => {
  let saved;
  const c = client({ tool: "text", activeTarget: { selector: "#p", text: { quote: "Original" } },
    draftComment: "", draftReplacement: "Original", replacementOpen: true, group: [], layout: null,
    mutate(operation) { saved = operation; },
  });
  c.commit(); assert.equal(saved, undefined); assert.match(c.notice, /comment/);
  c.draftComment = "Keep this as-is"; c.commit();
  assert.equal(saved.annotation.comment, "Keep this as-is"); assert.equal(saved.annotation.target.suggestion, undefined);
});

test("successful one-shot save restores Original while explicit Proposed remains visible", async () => {
  for (const mode of ["original", "proposed"]) {
    let restored = 0;
    const c = client({ previewMode: mode, keepAnnotating: false, textPreview: { restore() { restored++; } } });
    await c.mutate({}, async () => ({ annotation: { id: "saved" }, sessionRevision: 2 }), { tool: "text" });
    assert.equal(c.save, "Saved"); assert.equal(c.previewMode, mode);
    assert.equal(c.open, mode === "proposed"); assert.equal(c.panelOpen, false);
    assert.equal(restored, mode === "original" ? 1 : 0);
  }
});

test("closing and destroying restore source text and closing resets note/page comparisons", () => {
  let restored = 0; let destroyed = 0;
  const c = client({ previewMode: "proposed", notePreview: { id: "a", mode: "proposed" },
    textPreview: { restore() { restored++; }, destroy() { destroyed++; } }, unbind() {},
  });
  c.close(); assert.equal(restored, 1); assert.equal(c.previewMode, "original"); assert.equal(c.notePreview, null); assert.equal(c.open, false);
  globals({ document: { documentElement: { classList: { remove() {} } } } }, () => c.destroy());
  assert.equal(destroyed, 1);
});

test("navigation resets previews without requiring a full page reload", () => {
  const intervals = [];
  globals({ document: { addEventListener() {} }, window: { addEventListener() {}, setInterval(fn, delay) { intervals.push({ fn, delay }); } }, location: { href: "https://preview.test/new-page" } }, () => {
    let restored = 0;
    const c = client({ previewMode: "proposed", pageLocation: "https://preview.test/old-page", syncVisualViewport() {}, textPreview: { restore() { restored++; } } });
    c.bind(); intervals.find((item) => item.delay === 250).fn();
    assert.equal(c.pageLocation, location.href); assert.equal(c.previewMode, "original"); assert.equal(c.open, false); assert.equal(restored, 1);
  });
});

test("inline draft Original/Proposed comparison retains the unsaved replacement", () => {
  const applied = [];
  const c = client({ tool: "text", replacementOpen: true, draftReplacement: "Unsaved wording", draftOriginal: false,
    activeTarget: { text: { quote: "Original" } }, resolve: () => ({ status: "verified", element: {} }),
    textPreview: { restore() {}, range: () => ({ getBoundingClientRect: () => ({ x: 1, y: 2, width: 20, height: 10 }) }), apply(items) { applied.push(items); return new Map(); } },
  });
  c.updateTextPreview(); assert.equal(applied.at(-1)[0].target.suggestion.after, "Unsaved wording");
  c.draftOriginal = true; c.updateTextPreview(); assert.deepEqual(applied.at(-1), []); assert.equal(c.draftReplacement, "Unsaved wording");
  c.draftOriginal = false; c.updateTextPreview(); assert.equal(applied.at(-1)[0].target.suggestion.after, "Unsaved wording");
});
