import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createHash } from "node:crypto";
import { consumeReviewCapability, ReviewApi } from "../src/next/api.ts";
import { Outbox } from "../src/next/outbox.ts";
import { resolveTarget, textQuoteOffset } from "../src/next/targets.ts";
import { areaFromPoints, escapeAction, locationAction, suggestion } from "../src/next/interaction.ts";
import { ReviewClient } from "../src/next/index.ts";

const root = new URL("..", import.meta.url);
const bootstrap = await readFile(new URL("src/next/index.ts", root), "utf8");
const reviewClient = await readFile(new URL("src/next/review-client.ts", root), "utf8");
const styles = await readFile(new URL("src/next/styles.ts", root), "utf8");
const source = `${bootstrap}\n${reviewClient}\n${styles}`;
const targets = await readFile(new URL("src/next/targets.ts", root), "utf8");
const api = await readFile(new URL("src/next/api.ts", root), "utf8");
const outbox = await readFile(new URL("src/next/outbox.ts", root), "utf8");

test("client has framework-independent, Shadow-DOM isolated and inert rendering contracts", () => {
  assert.match(source, /attachShadow\(\{ mode: "open" \}\)/);
  assert.doesNotMatch(source + targets, /innerHTML/);
  assert.match(source, /textContent/);
  assert.match(source, /pointer-events:none/);
  assert.match(source, /@media \(max-width:600px\)/);
  assert.match(source, /min-height:44px/);
});

test("universal annotation, advanced tools, exact locations and recovery contracts are present", () => {
  assert.match(source, /Element \(E\) — click an element or select text/);
  assert.match(source, /captureTextSelection/);
  assert.match(source, /hover-ring/);
  assert.match(source, /pointer-plus/);
  assert.match(source, /markerGroups/);
  for (const tool of ["element", "text", "area", "group", "pause", "layout"]) assert.match(source, new RegExp(`"${tool}"`));
  for (const behavior of ["Escape", "previousFocus", "Location changed", "Open location", "Retarget", "scrollIntoView", "Edit text inline"]) assert.match(source, new RegExp(behavior));
  assert.match(source, /target-ring/);
  assert.match(source, /list\.scrollTop/);
  assert.match(source, /restorePause/);
});

test("transport uses fragment capability, exact review authorization, explicit revision and stable idempotency", () => {
  assert.match(api, /fragment\.get\("review"\)/);
  assert.match(api, /history\.replaceState/);
  assert.match(api, /Authorization: `Review/);
  assert.match(api, /Idempotency-Key/);
  assert.match(api, /If-Match/);
  assert.match(outbox, /ui-review-next:outbox/);
  assert.match(source, /error\.status === 409/);
});

test("target resolution fails closed and selector/geometry contracts are bounded", () => {
  assert.match(targets, /matches\.length !== 1/);
  assert.match(targets, /selector\.length <= 512/);
  assert.match(targets, /getBoundingClientRect/);
  assert.match(targets, /prefix/);
  assert.match(targets, /suffix/);
});

test("generated asset manifest is content addressed", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../static/ui-review-next.manifest.json", root), "utf8"));
  assert.match(manifest.asset, /^ui-review-next\.[a-f0-9]{16}\.js$/);
  assert.ok(manifest.assets.length >= 1);
  assert.equal(manifest.assets[0].asset, manifest.asset);
  for (const retained of manifest.assets) {
    const asset = await readFile(new URL(`../../static/${retained.asset}`, root));
    const digest = createHash("sha256").update(asset).digest("hex");
    assert.equal(digest, retained.sha256);
    assert.equal(retained.asset, `ui-review-next.${digest.slice(0, 16)}.js`);
  }
  assert.equal(manifest.assets[0].sha256, manifest.sha256);
});

test("the demo has a capability-free snippet placeholder", async () => {
  const html = await readFile(new URL("fixtures/static-review.html", root), "utf8");
  assert.match(html, /<!-- UI_REVIEW_SNIPPET -->/);
  assert.doesNotMatch(html, /#review=/);
});

test("fragment bootstrap scrubs the capability and preserves tab-local reload recovery", () => {
  let replacement; let state; const values = new Map(); const storage = { removeItem: (key) => values.delete(key), getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; const history = { state: { page: "notes" }, replaceState: (nextState, _title, value) => { state = nextState; history.state = nextState; replacement = value; } }; const location = { origin: "https://preview.test", hash: "#review=raw-capability&tab=notes", pathname: "/preview/a/", search: "?safe=1" }; const capability = consumeReviewCapability("session-a", location, history, storage);
  assert.equal(capability, "raw-capability"); assert.equal(replacement, "/preview/a/?safe=1#tab=notes");
  assert.equal(consumeReviewCapability("session-a", { ...location, hash: "" }, history, storage), "raw-capability");
  assert.equal(consumeReviewCapability("session-a", { ...location, hash: "" }, { state: {} }, storage), "raw-capability");
  assert.equal(state.page, "notes");
  assert.equal(consumeReviewCapability("session-b", { ...location, hash: "" }, history, storage), null);
  assert.equal(consumeReviewCapability("session-a", { ...location, hash: "" }, history, storage, "https://other.test"), null);
});

test("startup does not race a redundant refresh against typed edits", async () => {
  const calls = [];
  const empty = {
    mount: () => calls.push("mount"),
    load: async () => calls.push("load"),
    bind: () => calls.push("bind"),
    flush: async () => calls.push("flush"),
    outbox: { all: () => [] },
  };
  await ReviewClient.prototype.start.call(empty);
  assert.deepEqual(calls, ["mount", "load", "bind"]);

  empty.outbox.all = () => [{ id: "queued" }];
  await ReviewClient.prototype.start.call(empty);
  assert.deepEqual(calls.slice(-4), ["mount", "load", "bind", "flush"]);
});

test("review transport is endpoint-aware and preserves a caller-supplied idempotency key", async () => {
  let request; const apiClient = new ReviewApi({ sessionId: "a/b", endpoint: "https://preview.example/", capability: "cap", fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ sessionRevision: 2, annotation: { id: "n" } }), { status: 200 }); } });
  await apiClient.create({ type: "element", comment: "x", target: {} }, 1, "stable-operation");
  assert.equal(request.url, "https://preview.example/review-next/a%2Fb/annotations"); assert.equal(request.options.headers["Idempotency-Key"], "stable-operation"); assert.equal(request.options.headers.Authorization, "Review cap");
  assert.equal(request.options.headers.Origin, undefined); assert.equal(request.options.headers["X-Review-Origin"], undefined);
});

test("outbox and pure interaction helpers preserve deterministic recovery semantics", () => {
  const values = new Map(); const storage = { removeItem: (key) => values.delete(key), getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; const box = new Outbox("s", storage); box.add({ id: "same-key", operation: { kind: "create" } }); assert.equal(box.all()[0].id, "same-key");
  assert.deepEqual(areaFromPoints({ x: 80, y: 10 }, { x: 20, y: 50 }, { width: 390, height: 844 }), { x: 20, y: 10, width: 60, height: 40, viewport: { width: 390, height: 844 } });
  assert.equal(escapeAction("area", true), "cancel-tool"); assert.equal(escapeAction(null, true), "hide-panel"); assert.equal(locationAction({ route: "/other" }, "/here"), "open-location"); assert.deepEqual(suggestion("old", "new"), { before: "old", after: "new" });
});

test("universal composer emits element or exact-text notes and keeps replacement optional", () => {
  const capture = ({ tool, target, comment = "Change this", replacement = "", group = [], layout = null, pausedActive = false }) => {
    let operation;
    const fake = Object.create(ReviewClient.prototype);
    Object.assign(fake, {
      tool,
      activeTarget: target,
      draftComment: comment,
      draftReplacement: replacement,
      group,
      groupReady: tool === "group",
      layout,
      pausedActive,
      paused: pausedActive ? [{ animation: {} }] : [],
      data: { session: { revision: 4 }, annotations: [] },
      retarget: null,
      clearHover: () => {},
      mutate: (value) => { operation = value; },
    });
    ReviewClient.prototype.commit.call(fake);
    return operation.annotation;
  };

  const base = { selector: "#hero", tag: "p", nearbyText: "Original sentence" };
  assert.equal(capture({ tool: "inspect", target: base }).type, "element");
  const textOnly = capture({ tool: "text", target: { ...base, text: { quote: "Original sentence" } } });
  assert.equal(textOnly.type, "text");
  assert.equal("suggestion" in textOnly.target, false);
  const suggested = capture({ tool: "text", target: { ...base, text: { quote: "Original sentence" } }, replacement: "Clearer sentence" });
  assert.deepEqual(suggested.target.suggestion, { before: "Original sentence", after: "Clearer sentence" });

  const members = [base, { selector: "#cta", tag: "button" }];
  assert.equal(capture({ tool: "group", target: { ...base, group: members }, group: members }).type, "group");
  assert.equal(capture({ tool: "area", target: { ...base, area: { x: 1, y: 2, width: 3, height: 4, viewport: { width: 100, height: 100 } } } }).type, "area");
  const layout = { instruction: { intent: "rearrange", dx: 0, dy: 0, destinationSelector: "#cta", destinationTarget: { selector: "#cta", tag: "button" }, placement: "after" } };
  assert.equal(capture({ tool: "layout", target: { ...base, layout: layout.instruction }, layout }).type, "layout");
  assert.equal(capture({ tool: "inspect", target: base, pausedActive: true }).target.pause.animationCount, 1);
});

test("selector ambiguity fails closed instead of selecting a similar element", () => {
  const root = { querySelectorAll: () => [{ id: "one" }, { id: "two" }] }; assert.deepEqual(resolveTarget({ selector: ".duplicate" }, root), { status: "changed" });
});

test("saved Layout locations verify both source and destination", () => {
  const source = { id: "source", tagName: "DIV", dataset: {}, getAttribute: () => null, textContent: "Source" };
  const destination = { id: "destination", tagName: "DIV", dataset: {}, getAttribute: () => null, textContent: "Destination" };
  const target = { selector: "#source", layout: { destinationTarget: { selector: "#destination" } } };
  const root = { querySelectorAll: (selector) => selector === "#source" ? [source] : selector === "#destination" ? [destination] : [] };
  const result = resolveTarget(target, root);
  assert.equal(result.status, "verified");
  assert.equal(result.element, source);
  assert.equal(result.destinationElement, destination);
  assert.deepEqual(resolveTarget(target, { querySelectorAll: (selector) => selector === "#source" ? [source] : [] }), { status: "changed" });
});

test("collapsed shortcuts leave the host page alone", () => {
  const fake = Object.create(ReviewClient.prototype);
  fake.open = false;
  let prevented = false;
  fake.handleKey({ key: "Escape", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test("offline replay rebases two safe creates after each durable response", async () => {
  const operations = [
    { id: "one", operation: { kind: "create", annotation: { comment: "one" }, revision: 2 } },
    { id: "two", operation: { kind: "create", annotation: { comment: "two" }, revision: 2 } },
  ];
  const revisions = [];
  const fake = Object.create(ReviewClient.prototype);
  fake.data = { session: { revision: 2 }, annotations: [] };
  fake.outbox = { all: () => operations.slice(), remove: (id) => operations.splice(operations.findIndex((item) => item.id === id), 1) };
  fake.api = { create: async (_annotation, revision) => { revisions.push(revision); return { sessionRevision: revision + 1, annotation: { id: `n${revision}`, replies: [] } }; } };
  fake.applyEvent = ReviewClient.prototype.applyEvent.bind(fake);
  fake.load = async () => {};
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
  await fake.flush();
  assert.deepEqual(revisions, [2, 3]);
  assert.equal(operations.length, 0);
});

test("offline replay keeps a conflicting write and surfaces an actionable conflict", async () => {
  const operations = [{ id: "conflict", operation: { kind: "create", annotation: { comment: "queued" }, revision: 1 } }];
  const fake = Object.create(ReviewClient.prototype);
  fake.data = { session: { revision: 2 }, annotations: [] };
  fake.outbox = { all: () => operations.slice(), remove: () => operations.pop() };
  fake.api = { create: async () => { const error = new Error("conflict"); error.status = 409; throw error; } };
  let loaded = false; fake.load = async () => { loaded = true; }; fake.render = () => {};
  await fake.flush();
  assert.equal(loaded, true); assert.equal(operations.length, 1); assert.match(fake.notice, /retry or discard/); assert.equal(fake.conflictQueueId, "conflict"); assert.equal(fake.save, null);
  fake.discardQueued(); assert.equal(operations.length, 0); assert.equal(fake.save, "Saved");
});

test("a lost Finish response replays with the same durable operation id", async () => {
  const queued = [];
  const ids = [];
  let first = true;
  const fake = Object.create(ReviewClient.prototype);
  fake.data = { session: { revision: 7, status: "open" }, annotations: [] };
  fake.outbox = {
    all: () => queued.slice(),
    add: (item) => queued.push(item),
    remove: (id) => { const index = queued.findIndex((item) => item.id === id); if (index >= 0) queued.splice(index, 1); },
  };
  fake.api = { finish: async (_revision, id) => { ids.push(id); if (first) { first = false; throw new TypeError("response lost"); } return { session: { revision: 8, status: "finished" } }; } };
  fake.render = () => {};
  fake.restorePause = () => {};
  fake.applyEvent = ReviewClient.prototype.applyEvent.bind(fake);
  fake.load = async () => {};
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
  await fake.finish();
  assert.equal(queued.length, 1);
  await fake.flush();
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(queued.length, 0);
  assert.equal(fake.data.session.status, "finished");
});

test("selector verification fails closed on structural semantic mismatch", () => {
  const element = { id: "", tagName: "DIV", dataset: {}, getAttribute: () => null, textContent: "Unexpected content" };
  const root = { querySelectorAll: () => [element] };
  assert.deepEqual(resolveTarget({ selector: "main > p", tag: "p", nearbyText: "Expected" }, root), { status: "changed" });
});

test("text locations reopen the exact repeated selection and fail closed when ambiguous", () => {
  const whole = "repeat this phrase, then repeat this phrase again.";
  const quote = "repeat this phrase";
  const second = whole.lastIndexOf(quote);
  assert.equal(textQuoteOffset({ quote, offset: second }, whole), second);
  assert.equal(textQuoteOffset({ quote, prefix: "then ", suffix: " again." }, whole), second);
  assert.equal(textQuoteOffset({ quote }, whole), null);
});
