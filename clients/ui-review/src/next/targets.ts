const sensitive = ["token", "key", "secret", "password", "passcode", "review", "auth", "authorization", "code", "credential", "signature", "session", "email", "jwt", "sig"];
function sensitiveKey(key) { const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, ""); return sensitive.some((marker) => normalized.includes(marker)); }
export function cleanPageUrl(url = window.location.href) {
  const parsed = new URL(url, window.location.origin); parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) if (sensitiveKey(key)) parsed.searchParams.delete(key);
  return parsed.href;
}
export function rectOf(element) { const r = element.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), viewport: { width: window.innerWidth, height: window.innerHeight } }; }
function escapePart(value) { return CSS.escape(String(value)); }
export function selectorFor(element) {
  if (!(element instanceof Element)) return null;
  if (element.id) return `#${escapePart(element.id)}`;
  if ((element as HTMLElement).dataset?.testid) return `[data-testid="${escapePart((element as HTMLElement).dataset.testid)}"]`;
  const steps = []; let current = element;
  while (current && current !== document.body && steps.length < 8) { const siblings = [...current.parentElement.children].filter((node) => node.tagName === current.tagName); steps.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`); current = current.parentElement; }
  return steps.length ? `body > ${steps.join(" > ")}` : null;
}
export function validSelector(selector) { return typeof selector === "string" && selector.length > 0 && selector.length <= 512 && !/[{};]/.test(selector); }
function normalizedText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
export function textQuoteOffset(textTarget, wholeText) {
  const quote = textTarget?.quote;
  const whole = String(wholeText || "");
  if (!quote) return null;

  const stored = textTarget.offset;
  if (Number.isInteger(stored) && stored >= 0 && whole.slice(stored, stored + quote.length) === quote) return stored;

  const candidates = [];
  for (let index = whole.indexOf(quote); index >= 0; index = whole.indexOf(quote, index + 1)) {
    const prefix = textTarget.prefix || "";
    const suffix = textTarget.suffix || "";
    const prefixStart = Math.max(0, index - prefix.length);
    const prefixMatches = !prefix || whole.slice(prefixStart, index).endsWith(prefix);
    const suffixMatches = !suffix || whole.slice(index + quote.length, index + quote.length + suffix.length).startsWith(suffix);
    if (prefixMatches && suffixMatches) candidates.push(index);
  }
  return candidates.length === 1 ? candidates[0] : null;
}
function resolveOne(target, root) {
  const route = root.location?.pathname || root.ownerDocument?.location?.pathname;
  if (target?.route && route && target.route !== route) return { status: "other-route" };
  if (!target?.selector || !validSelector(target.selector)) return { status: "changed" };
  let matches; try { matches = root.querySelectorAll(target.selector); } catch { return { status: "changed" }; }
  if (matches.length !== 1) return { status: "changed" };
  const element = matches[0];
  if (target.stableId && element.id !== target.stableId && element.dataset?.testid !== target.stableId) return { status: "changed" };
  if (target.tag && element.tagName?.toLowerCase() !== String(target.tag).toLowerCase()) return { status: "changed" };
  if (target.role && element.getAttribute?.("role") !== target.role) return { status: "changed" };
  if (target.name && element.getAttribute?.("aria-label") !== target.name) return { status: "changed" };
  const currentText = normalizedText(element.innerText ?? element.textContent);
  if (target.nearbyText && !currentText.includes(normalizedText(target.nearbyText))) return { status: "changed" };
  if (target.text?.quote && textQuoteOffset(target.text, element.textContent || "") === null) return { status: "changed" };
  return { status: "verified", element };
}
export function resolveTarget(target, root = document) {
  const primary = resolveOne(target, root); if (primary.status !== "verified") return primary;
  if (target.layout?.destinationTarget) {
    const destination = resolveOne(target.layout.destinationTarget, root);
    if (destination.status !== "verified" || target.layout.destinationTarget.selector === target.selector) return { status: "changed" };
    return { ...primary, destinationElement: destination.element };
  }
  if (!Array.isArray(target.group)) return primary;
  const elements = []; const selectors = new Set();
  for (const member of target.group) { const result = resolveOne(member, root); if (result.status !== "verified" || selectors.has(member.selector)) return { status: "changed" }; selectors.add(member.selector); elements.push(result.element); }
  return { status: "verified", element: primary.element, elements };
}
export function targetFor(element) {
  const selection = window.getSelection();
  const rawSelection = selection?.toString() || "";
  const text = rawSelection.trim();
  const whole = element.textContent || "";
  const visible = element instanceof HTMLElement ? element.innerText : "";
  const safeContext = normalizedText(visible) === normalizedText(whole);
  let quote;
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (text && range && element.contains(range.commonAncestorContainer)) {
    try {
      const before = document.createRange();
      before.selectNodeContents(element);
      before.setEnd(range.startContainer, range.startOffset);
      const offset = before.toString().length + rawSelection.indexOf(text);
      if (whole.slice(offset, offset + text.length) === text && visible.includes(text)) {
        quote = {
          quote: text,
          ...(safeContext ? { prefix: whole.slice(Math.max(0, offset - 48), offset), suffix: whole.slice(offset + text.length, offset + text.length + 48) } : {}),
          offset,
        };
      }
    } catch {
      quote = undefined;
    }
  }
  return { pageUrl: cleanPageUrl(), route: location.pathname, selector: selectorFor(element), stableId: element.id || element.dataset?.testid || undefined, role: element.getAttribute("role") || undefined, name: element.getAttribute("aria-label") || undefined, tag: element.tagName.toLowerCase(), nearbyText: normalizedText(visible).slice(0, 240), rect: rectOf(element), text: quote };
}
