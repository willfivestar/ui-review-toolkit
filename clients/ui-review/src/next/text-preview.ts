import { resolveTarget, textQuoteOffset } from "./targets.ts";

type PreviewItem = { id: string; target: any };
type Segment = { node: Text; start: number; end: number };
type Prepared = { item: PreviewItem; segments: Segment[] };
type Displayed = { target: any; node: Text; start: number; end: number; expected: Map<Text, string>; element: Element };

// Preview only ordinary display text. In particular, never change a field's value,
// editability, executable contents, or the review client's own UI.
const unsafe = "input,textarea,select,option,script,style,noscript,template,iframe,canvas,[contenteditable]:not([contenteditable='false']),[data-ui-review-next]";
function unsafeNode(node: Text | Element) {
  const element = node.nodeType === 3 ? node.parentElement : node as Element;
  return !element || Boolean(element.closest(unsafe)) ||
    Boolean(element.namespaceURI && element.namespaceURI !== "http://www.w3.org/1999/xhtml");
}

export class TextPreview {
  private root: Document;
  private writes = new Map<Text, { before: string; after: string }>();
  private items: PreviewItem[] = [];
  private displayed: Displayed[] = [];

  constructor(root = document) { this.root = root; }

  restore(): void {
    for (const [node, value] of this.writes) {
      // A framework or the host may have changed this node since our preview.
      // Its update wins; never restore an obsolete value over it.
      if (node.data === value.after) node.data = value.before;
    }
    this.writes.clear();
    this.items = [];
    this.displayed = [];
  }

  private segments(target): { status: string; segments?: Segment[] } {
    const result = resolveTarget(target, this.root);
    if (result.status !== "verified") return { status: result.status };
    const element = result.element;
    if (unsafeNode(element)) return { status: "unsupported" };
    const quote = target?.text?.quote;
    if (typeof quote !== "string" || !quote.length) return { status: "unsupported" };
    const offset = textQuoteOffset(target.text, element.textContent);
    if (offset === null) return { status: "changed" };
    const walker = this.root.createTreeWalker(element, 4 /* SHOW_TEXT */);
    const segments: Segment[] = [];
    let node: Text; let cursor = 0;
    while ((node = walker.nextNode() as Text)) {
      const length = node.data.length;
      const start = Math.max(0, offset - cursor);
      const end = Math.min(length, offset + quote.length - cursor);
      if (end > start) {
        if (unsafeNode(node)) return { status: "unsupported" };
        segments.push({ node, start, end });
      }
      cursor += length;
      if (cursor >= offset + quote.length) break;
    }
    if (!segments.length || segments.map(({ node, start, end }) => node.data.slice(start, end)).join("") !== quote) return { status: "changed" };
    return { status: "verified", segments };
  }

  range(target): Range | null {
    const result = this.segments(target);
    if (result.status !== "verified") return null;
    const first = result.segments[0];
    const last = result.segments[result.segments.length - 1];
    const range = this.root.createRange();
    range.setStart(first.node, first.start);
    range.setEnd(last.node, last.end);
    return range;
  }

  // Unlike range(), this measures the already-displayed proposal without
  // touching the DOM or searching again for the original phrase.
  displayedRange(target): Range | null {
    const sameTarget = (saved) => saved.selector === target?.selector && saved.route === target?.route &&
      saved.text?.quote === target?.text?.quote && saved.text?.offset === target?.text?.offset &&
      saved.text?.prefix === target?.text?.prefix && saved.text?.suffix === target?.text?.suffix;
    const found = this.displayed.find((item) => sameTarget(item.target));
    if (!found || found.node.isConnected === false) return null;
    if (target.route && this.root.location?.pathname && target.route !== this.root.location.pathname) return null;
    if ([...found.expected].some(([node, data]) => node.data !== data || node.isConnected === false)) return null;
    let matches;
    try { matches = this.root.querySelectorAll(target.selector); } catch { return null; }
    if (matches.length !== 1 || matches[0] !== found.element || unsafeNode(found.node)) return null;
    const range = this.root.createRange();
    range.setStart(found.node, found.start);
    range.setEnd(found.node, found.end);
    return range;
  }

  apply(items: PreviewItem[]): Map<string, string> {
    this.restore();
    const statuses = new Map<string, string>();
    const prepared: Prepared[] = [];
    for (const item of items) {
      const suggestion = item.target?.suggestion;
      if (!suggestion || typeof suggestion.after !== "string" || suggestion.before !== item.target?.text?.quote) {
        statuses.set(item.id, "unsupported"); continue;
      }
      const result = this.segments(item.target);
      if (result.status !== "verified") { statuses.set(item.id, result.status); continue; }
      prepared.push({ item, segments: result.segments });
      statuses.set(item.id, "applied");
    }
    // Detect against physical text nodes, not selectors: ancestor/descendant
    // targets can address the same characters through entirely different paths.
    for (let i = 0; i < prepared.length; i += 1) {
      for (let j = i + 1; j < prepared.length; j += 1) {
        if (prepared[i].segments.some((a) => prepared[j].segments.some((b) => a.node === b.node && a.start < b.end && b.start < a.end))) {
          statuses.set(prepared[i].item.id, "conflict");
          statuses.set(prepared[j].item.id, "conflict");
        }
      }
    }
    const edits = new Map<Text, { start: number; end: number; after: string }[]>();
    for (const { item, segments } of prepared) {
      if (statuses.get(item.id) !== "applied") continue;
      segments.forEach(({ node, start, end }, index) => {
        const current = edits.get(node) || [];
        current.push({ start, end, after: index === 0 ? item.target.suggestion.after : "" });
        edits.set(node, current);
      });
    }
    for (const [node, changes] of edits) {
      const before = node.data;
      let after = before;
      for (const change of changes.sort((a, b) => b.start - a.start)) after = after.slice(0, change.start) + change.after + after.slice(change.end);
      if (after !== before) { this.writes.set(node, { before, after }); node.data = after; }
    }
    for (const { item, segments } of prepared) {
      if (statuses.get(item.id) !== "applied") continue;
      const first = segments[0];
      const shift = (edits.get(first.node) || []).filter((change) => change.end <= first.start)
        .reduce((total, change) => total + change.after.length - (change.end - change.start), 0);
      const start = first.start + shift;
      this.displayed.push({
        target: { ...item.target, text: { ...item.target.text } }, node: first.node,
        start, end: start + item.target.suggestion.after.length,
        expected: new Map(segments.map(({ node }) => [node, node.data])),
        element: this.root.querySelectorAll(item.target.selector)[0],
      });
    }
    this.items = items.slice();
    return statuses;
  }

  resolve(target) {
    if (!this.items.length) return resolveTarget(target, this.root);
    const items = this.items.slice();
    this.restore();
    try { return resolveTarget(target, this.root); }
    finally { this.apply(items); }
  }

  destroy(): void { this.restore(); }
}
