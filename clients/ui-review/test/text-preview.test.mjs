import assert from "node:assert/strict";
import test from "node:test";
import { TextPreview } from "../src/next/text-preview.ts";

// Minimal DOM-shaped fixture keeps engine tests dependency-free. Browser tests
// additionally exercise native Range geometry and real markup preservation.
function fixture() {
  const registry = new Map();
  const element = (id, ...children) => {
    const value = { nodeType: 1, id, tagName: "P", dataset: {}, parentElement: null, children,
      getAttribute: () => null,
      closest: () => value.blocked || value.parentElement?.closest() || null,
      get textContent() { return children.map((child) => child.nodeType === 3 ? child.data : child.textContent).join(""); },
    };
    children.forEach((child) => { child.parentElement = value; });
    registry.set(`#${id}`, value);
    return value;
  };
  const text = (data) => ({ nodeType: 3, data, parentElement: null });
  const root = {
    location: { pathname: "/review" },
    querySelectorAll: (selector) => registry.has(selector) ? [registry.get(selector)] : [],
    createTreeWalker: (node) => {
      const all = []; const collect = (current) => current.nodeType === 3 ? all.push(current) : current.children.forEach(collect);
      collect(node); let i = 0; return { nextNode: () => all[i++] || null };
    },
    createRange: () => ({ setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }, setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; } }),
  };
  const item = (id, selector, quote, after, offset = 0) => ({ id, target: { selector, route: "/review", text: { quote, offset }, suggestion: { before: quote, after } } });
  return { element, text, root, item, preview: new TextPreview(root) };
}

test("previews multiple nonoverlapping edits and restores exact original text", () => {
  const f = fixture(); const text = f.text("Hello world, hello friend"); const element = f.element("p", text);
  const a = f.item("a", "#p", "Hello", "Goodbye"); const b = f.item("b", "#p", "friend", "neighbor", 19);
  assert.deepEqual([...f.preview.apply([a, b])], [["a", "applied"], ["b", "applied"]]);
  assert.equal(element.textContent, "Goodbye world, hello neighbor");
  assert.equal(f.preview.resolve(a.target).status, "verified");
  assert.equal(element.textContent, "Goodbye world, hello neighbor");
  f.preview.restore(); assert.equal(text.data, "Hello world, hello friend");
});

test("multi-node replacements preserve elements, node identity and unrelated text", () => {
  const f = fixture(); const a = f.text("Hello "); const b = f.text("bold"); const c = f.text(" world!");
  const strong = f.element("strong", b); const element = f.element("p", a, strong, c);
  const target = f.item("a", "#p", "lo bold wor", "replacement", 3);
  assert.equal(f.preview.apply([target]).get("a"), "applied");
  assert.equal(element.textContent, "Helreplacementld!"); assert.equal(element.children[1], strong);
  f.preview.restore(); assert.equal(element.textContent, "Hello bold world!"); assert.equal(strong.children[0], b);
  const range = f.preview.range(target.target);
  assert.equal(range.startContainer, a); assert.equal(range.startOffset, 3); assert.equal(range.endContainer, c); assert.equal(range.endOffset, 4);
});

test("overlap across nested selectors flags both notes and preserves unrelated edits", () => {
  const f = fixture(); const text = f.text("Hello world"); const child = f.element("child", text); const parent = f.element("parent", child);
  const notes = [f.item("a", "#parent", "Hello world", "A"), f.item("b", "#child", "world", "B", 6)];
  const status = f.preview.apply(notes); assert.equal(status.get("a"), "conflict"); assert.equal(status.get("b"), "conflict"); assert.equal(parent.textContent, "Hello world");
});

test("touching but nonoverlapping ranges are safe, including plain text deletion", () => {
  const f = fixture(); const text = f.text("abcd"); f.element("p", text);
  const status = f.preview.apply([f.item("a", "#p", "ab", ""), f.item("b", "#p", "cd", "<b>new</b>", 2)]);
  assert.equal(status.get("a"), "applied"); assert.equal(status.get("b"), "applied"); assert.equal(text.data, "<b>new</b>");
  f.preview.destroy(); assert.equal(text.data, "abcd");
});

test("changed, ambiguous, foreign-route, and unsafe text fail closed", () => {
  const f = fixture(); const text = f.text("same same"); const element = f.element("p", text);
  const ambiguous = f.item("ambiguous", "#p", "same", "different", undefined); delete ambiguous.target.text.offset;
  const changed = f.item("changed", "#p", "absent", "different");
  const foreign = f.item("foreign", "#p", "same", "different"); foreign.target.route = "/elsewhere";
  const mismatched = f.item("mismatch", "#p", "same", "different"); mismatched.target.suggestion.before = "stale";
  assert.deepEqual([...f.preview.apply([ambiguous, changed, foreign, mismatched])], [["ambiguous", "changed"], ["changed", "changed"], ["foreign", "other-route"], ["mismatch", "unsupported"]]);
  element.blocked = element;
  assert.equal(f.preview.apply([f.item("unsafe", "#p", "same", "different")]).get("unsafe"), "unsupported");
  assert.equal(f.preview.range(f.item("a", "#p", "same", "x").target), null);
});

test("host changes win over stale restoration and subsequent previews", () => {
  const f = fixture(); const text = f.text("Original"); f.element("p", text); const item = f.item("a", "#p", "Original", "Proposed");
  f.preview.apply([item]); text.data = "Host update";
  f.preview.restore(); assert.equal(text.data, "Host update");
  assert.equal(f.preview.apply([item]).get("a"), "changed"); assert.equal(text.data, "Host update");
});

test("switching proposal sets restores previous previews before resolving the next", () => {
  const f = fixture(); const text = f.text("Original"); f.element("p", text);
  f.preview.apply([f.item("a", "#p", "Original", "First")]);
  assert.equal(f.preview.apply([f.item("b", "#p", "Original", "Second")]).get("b"), "applied"); assert.equal(text.data, "Second");
  f.preview.apply([]); assert.equal(text.data, "Original");
});

test("displayed ranges track replacement offsets after earlier and later nonoverlap edits", () => {
  const f = fixture(); const text = f.text("one two three"); f.element("p", text);
  const first = f.item("first", "#p", "one", "longer one");
  const middle = f.item("middle", "#p", "two", "second", 4);
  const last = f.item("last", "#p", "three", "3", 8);
  f.preview.apply([last, middle, first]);
  assert.equal(text.data, "longer one second 3");
  for (const [item, start, end] of [[first, 0, 10], [middle, 11, 17], [last, 18, 19]]) {
    const range = f.preview.displayedRange(structuredClone(item.target));
    assert.equal(range.startContainer, text); assert.equal(range.endContainer, text);
    assert.equal(range.startOffset, start); assert.equal(range.endOffset, end);
    assert.equal(text.data.slice(start, end), item.target.suggestion.after);
  }
  assert.equal(text.data, "longer one second 3");
  f.preview.restore(); assert.equal(f.preview.displayedRange(first.target), null);
});

test("multi-node proposal and deletion ranges point only to their displayed replacement", () => {
  const f = fixture(); const first = f.text("First "); const second = f.text("bold words"); const third = f.text(" end");
  const child = f.element("child", second); f.element("p", first, child, third);
  const item = f.item("a", "#p", "st bold wor", "new", 3);
  f.preview.apply([item]); const range = f.preview.displayedRange(item.target);
  assert.equal(range.startContainer, first); assert.equal(range.endContainer, first);
  assert.equal(range.startOffset, 3); assert.equal(range.endOffset, 6);
  item.target.suggestion.after = ""; f.preview.apply([item]);
  const deleted = f.preview.displayedRange(item.target);
  assert.equal(deleted.startOffset, 3); assert.equal(deleted.endOffset, 3);
  second.data = "Host changes continuation"; assert.equal(f.preview.displayedRange(item.target), null);
});

test("displayed range never binds to unchanged phrases, conflicting notes, or changed host nodes", () => {
  const f = fixture(); const text = f.text("same same"); f.element("p", text);
  const first = f.item("first", "#p", "same", "different", 0);
  const second = f.item("second", "#p", "same", "other", 5);
  f.preview.apply([first]); assert.equal(f.preview.displayedRange(second.target), null);
  text.data = "Host update"; assert.equal(f.preview.displayedRange(first.target), null);
  text.data = "same same"; f.preview.apply([first, f.item("duplicate", "#p", "same", "overlap", 0)]);
  assert.equal(f.preview.displayedRange(first.target), null);
});
