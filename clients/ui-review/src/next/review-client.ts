import { reviewScope, ReviewApi } from "./api.ts";
import { Outbox } from "./outbox.ts";
import { areaFromPoints, clampDockPosition, locationAction, suggestion } from "./interaction.ts";
import { rectOf, resolveTarget, targetFor, textQuoteOffset } from "./targets.ts";
import { css, icons, pageStyle } from "./styles.ts";
import { TextPreview } from "./text-preview.ts";

function node(tag, options: any = {}, children: any[] = []) {
  const element = document.createElement(tag);
  Object.assign(element, options);
  for (const child of children) element.append(child);
  return element;
}

function button(label, handler, className = "") {
  const control = node("button", { type: "button", textContent: label, className });
  control.addEventListener("click", handler);
  return control;
}

function svgIcon(parts) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attributes] of parts) {
    const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, String(value));
    svg.append(child);
  }
  return svg;
}

function iconButton(label, icon, handler, className = "") {
  const control = node("button", { type: "button", className: `icon ${className}`, title: label });
  control.setAttribute("aria-label", label);
  control.dataset.tooltip = label;
  control.append(svgIcon(icon));
  control.addEventListener("click", handler);
  return control;
}

function focusFirstVisible(root, selector) {
  queueMicrotask(() => [...root.querySelectorAll(selector)].find((element: any) => element.getClientRects().length)?.focus());
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function point(rect) {
  return { x: rect.x + Math.min(20, rect.width / 2), y: rect.y + Math.min(20, rect.height / 2) };
}

function normalized(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unionRects(rects) {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left ?? rect.x));
  const top = Math.min(...rects.map((rect) => rect.top ?? rect.y));
  const right = Math.max(...rects.map((rect) => rect.right ?? ((rect.x || 0) + rect.width)));
  const bottom = Math.max(...rects.map((rect) => rect.bottom ?? ((rect.y || 0) + rect.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function quoteRect(element, textTarget) {
  if (!element || !textTarget?.quote) return null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let whole = "";
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const textNode = current as Text;
    nodes.push({ node: textNode, start: whole.length, end: whole.length + textNode.data.length });
    whole += textNode.data;
  }
  const start = textQuoteOffset(textTarget, whole);
  if (start === null) return null;
  const end = start + textTarget.quote.length;
  const first = nodes.find((item) => start >= item.start && start <= item.end);
  const last = [...nodes].reverse().find((item) => end >= item.start && end <= item.end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, clamp(start - first.start, 0, first.node.data.length));
  range.setEnd(last.node, clamp(end - last.start, 0, last.node.data.length));
  const rects = [...range.getClientRects()].filter((rect) => rect.width || rect.height);
  return unionRects(rects);
}

function targetRect(target, resolved) {
  if (resolved?.textRect) return resolved.textRect;
  if (target?.area) {
    return {
      ...target.area,
      x: target.area.x + (target.area.scrollX || 0) - window.scrollX,
      y: target.area.y + (target.area.scrollY || 0) - window.scrollY,
    };
  }
  if (target?.text?.quote && resolved?.element && !resolved.textPreviewActive) {
    const exact = quoteRect(resolved.element, target.text);
    if (exact) return exact;
  }
  const elements = resolved?.elements || (resolved?.element ? [resolved.element] : []);
  return unionRects(elements.map(rectOf)) || target?.rect || null;
}

function setRect(element, rect) {
  Object.assign(element.style, {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${Math.max(1, rect.width)}px`,
    height: `${Math.max(1, rect.height)}px`,
  });
}

function labelFor(element) {
  if (!element) return "Page element";
  const explicit = element.getAttribute?.("aria-label") || element.dataset?.testid || element.id;
  if (explicit) return explicit;
  const words = normalized(element.textContent).slice(0, 48);
  return words || element.tagName?.toLowerCase?.() || "Page element";
}

function labelForTarget(target) {
  if (target?.text?.quote) return `Selected text in ${target.name || target.stableId || target.tag || "element"}`;
  if (target?.area) return "Selected page area";
  if (target?.group) return `${target.group.length} selected elements`;
  if (target?.layout) return "Layout relationship";
  return target?.name || target?.stableId || target?.nearbyText?.slice(0, 48) || target?.tag || "Page element";
}

function plainTarget(element) {
  const target = targetFor(element);
  delete target.text;
  return target;
}

export class ReviewClientImplementation {
  [key: string]: any;

  constructor(options: any) {
    this.options = options;
    this.capability = options.capability;
    this.api = new ReviewApi(options);
    this.outbox = new Outbox(reviewScope(options.sessionId, options.endpoint));
    this.data = { session: null, annotations: [] };
    this.sequence = 0;
    this.tool = null;
    this.selectedId = null;
    this.highlightedId = null;
    this.activeTarget = null;
    this.group = [];
    this.groupReady = false;
    this.layout = null;
    this.paused = [];
    this.pausedActive = false;
    this.previousFocus = document.activeElement;
    this.open = false;
    this.panelOpen = false;
    this.markersVisible = true;
    this.advancedOpen = false;
    this.moreOpen = false;
    this.clusterIds = null;
    this.showHint = true;
    this.draftComment = "";
    this.draftReplacement = "";
    this.replacementOpen = false;
    this.textPreview = new TextPreview();
    this.previewMode = "original";
    this.notePreview = null;
    this.previewStatuses = new Map();
    this.pageLocation = location.href;
    try { this.dockPosition = JSON.parse(localStorage.getItem("ui-review-next:dock-position") || "null"); } catch { this.dockPosition = null; }
    try { this.keepAnnotating = localStorage.getItem("ui-review-next:keep-annotating") === "true"; } catch { this.keepAnnotating = false; }
  }

  async start() {
    this.mount();
    await this.load();
    this.bind();
    if (this.outbox.all().length) await this.flush();
  }

  mount() {
    this.pageStyle = node("style", { textContent: pageStyle });
    this.pageStyle.dataset.uiReviewNext = "page-style";
    document.head.append(this.pageStyle);
    this.host = document.createElement("ui-review-next");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.append(node("style", { textContent: css }));
    this.root = node("div", { className: "root" });
    this.shadow.append(this.root);
    document.documentElement.append(this.host);
    this.render();
  }

  destroy() {
    this.textPreview?.destroy();
    this.unbind();
    this.restorePause();
    document.documentElement.classList.remove("ui-review-next-inspecting");
    this.pageStyle?.remove();
    this.host?.remove();
    this.previousFocus?.focus?.();
  }

  bind() {
    this.onKey = (event) => this.handleKey(event);
    this.onPointer = (event) => this.capturePointerDown(event);
    this.onMove = (event) => this.capturePointerMove(event);
    this.onUp = (event) => this.capturePointerUp(event);
    this.onClick = (event) => this.captureClick(event);
    this.onOnline = () => this.flush();
    this.onViewport = () => {
      this.syncVisualViewport();
      this.positionDock();
      if (this.replacementOpen) {
        this.updateTextPreview();
        const input = this.root.querySelector('[data-focus-token="inline-text"]');
        if (input && this.inlineAnchor) this.positionInlineInput(input);
        else input?.remove();
        const editor = this.root.querySelector('.context-card');
        if (editor) this.positionContextEditor(editor);
      }
      this.scheduleOverlayUpdate();
    };
    document.addEventListener("keydown", this.onKey, true);
    document.addEventListener("pointerdown", this.onPointer, true);
    document.addEventListener("pointermove", this.onMove, true);
    document.addEventListener("pointerup", this.onUp, true);
    document.addEventListener("click", this.onClick, true);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("scroll", this.onViewport, true);
    window.addEventListener("resize", this.onViewport);
    window.visualViewport?.addEventListener("resize", this.onViewport);
    window.visualViewport?.addEventListener("scroll", this.onViewport);
    this.syncVisualViewport();
    this.poll = window.setInterval(() => this.refreshEvents(), 15000);
    this.routePoll = window.setInterval(() => {
      if (this.pageLocation !== location.href) {
        this.pageLocation = location.href;
        this.close();
      }
    }, 250);
  }

  unbind() {
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("pointerdown", this.onPointer, true);
    document.removeEventListener("pointermove", this.onMove, true);
    document.removeEventListener("pointerup", this.onUp, true);
    document.removeEventListener("click", this.onClick, true);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("scroll", this.onViewport, true);
    window.removeEventListener("resize", this.onViewport);
    window.visualViewport?.removeEventListener("resize", this.onViewport);
    window.visualViewport?.removeEventListener("scroll", this.onViewport);
    clearInterval(this.poll);
    clearInterval(this.routePoll);
    clearTimeout(this.suppressClickTimer);
    cancelAnimationFrame(this.overlayFrame);
    cancelAnimationFrame(this.hoverFrame);
  }

  isReviewEvent(event) {
    return event.composedPath?.().includes(this.host) || event.target === this.host;
  }

  handleKey(event) {
    if (event.key === "Escape") {
      if (!this.open) return;
      event.preventDefault();
      if (this.advancedOpen || this.moreOpen) {
        const returnToken = this.advancedOpen ? "toolbar-advanced" : "toolbar-more";
        this.advancedOpen = false;
        this.moreOpen = false;
        this.render();
        queueMicrotask(() => this.root.querySelector(`[data-focus-token="${returnToken}"]`)?.focus());
      } else if (this.tool || this.activeTarget) {
        this.cancelTool();
      } else if (this.panelOpen) {
        this.panelOpen = false;
        this.render();
      } else if (this.open) {
        this.close();
      } else {
        this.launch();
      }
      return;
    }
    if (!this.writable()) return;
    // Document listeners see the shadow host as event.target, not the editor.
    const editing = (event.composedPath?.() || [event.target]).some((target) =>
      target?.matches?.("input,textarea,select,[contenteditable]:not([contenteditable=false])"));
    if (editing || event.repeat || event.isComposing || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (["e", "f", "t"].includes(key) && !this.activeTarget) {
      event.preventDefault?.();
      this.beginTool(key === "t" ? "text" : "inspect");
    }
    if (this.open && key === "p") this.togglePause();
  }

  syncVisualViewport() {
    const viewport = window.visualViewport;
    if (!viewport || !this.root) return;
    Object.assign(this.root.style, {
      inset: "auto",
      left: "0",
      top: "0",
      width: `${viewport.width}px`,
      height: `${viewport.height}px`,
      transform: `translate(${viewport.offsetLeft}px, ${viewport.offsetTop}px)`,
    });
    this.root.style.setProperty("--review-viewport-height", `${viewport.height}px`);
  }

  async load() {
    const wasLocked = this.needsPasscode;
    try {
      const value = await this.api.load();
      this.needsPasscode = false;
      this.data = { session: value.session, annotations: value.annotations || [] };
      this.save = "Saved";
      if (wasLocked && this.open && ["open", "reopened"].includes(value.session?.status)) {
        this.panelOpen = false;
        this.tool = null;
      }
      this.render();
    } catch (error) {
      this.needsPasscode = [401, 403, 404].includes(error.status);
      this.save = "Offline";
      this.notice = this.needsPasscode ? "Enter the optional review passcode, or ask the builder for a current link." : error.message;
      this.render();
    }
  }

  async refreshEvents() {
    if (this.draggingDock) return;
    if (!navigator.onLine) return;
    try {
      const value = await this.api.events(this.sequence);
      this.sequence = value.nextSequence || this.sequence;
      for (const event of value.events || []) this.applyEvent(event);
      if (!this.activeTarget && !this.shadow.activeElement?.matches?.("input,textarea")) this.render();
    } catch {
      // A normal grant expiry or transient network error is reflected by the next user action.
    }
  }

  applyEvent(event) {
    if (event.session) this.data.session = event.session;
    const annotation = event.annotation || event.current;
    if (!annotation) return;
    const index = this.data.annotations.findIndex((item) => item.id === annotation.id);
    if (index >= 0) this.data.annotations[index] = annotation;
    else this.data.annotations.push(annotation);
  }

  writable() {
    return ["open", "reopened"].includes(this.data.session?.status);
  }

  launch() {
    this.open = true;
    this.panelOpen = Boolean(this.needsPasscode || !this.data.session || !this.writable());
    this.tool = null;
    this.render();
  }

  close() {
    this.textPreview?.restore();
    this.previewMode = "original";
    this.notePreview = null;
    this.draftOriginal = false;
    this.interactionVersion = (this.interactionVersion || 0) + 1;
    if (this.activeTarget?.text) globalThis.window?.getSelection?.()?.removeAllRanges();
    this.open = false;
    this.panelOpen = false;
    this.advancedOpen = false;
    this.moreOpen = false;
    this.tool = null;
    this.activeTarget = null;
    this.group = [];
    this.groupReady = false;
    this.layout = null;
    this.retarget = null;
    this.areaStart = null;
    this.areaDrawing = false;
    this.draftComment = "";
    this.draftReplacement = "";
    this.replacementOpen = false;
    this.selectedId = null;
    this.highlightedId = null;
    this.restorePause();
    this.clearHover();
    this.render();
  }

  render() {
    if (!this.root) return;
    this.updateTextPreview();
    const priorList = this.root.querySelector(".list");
    const listScroll = priorList?.scrollTop;
    const focusToken = this.shadow.activeElement?.dataset?.focusToken;
    this.root.replaceChildren();

    if (!this.open) {
      this.renderLauncher();
      this.positionDock();
      this.syncInspectCursor();
      return;
    }

    this.renderToolbar();
    if (this.advancedOpen) this.renderAdvancedMenu();
    if (this.moreOpen) this.renderMoreMenu();
    if (this.markersVisible) this.renderMarkers();
    if (this.panelOpen) this.renderPanel(listScroll);
    this.renderSelectionHud();
    this.renderTargetRing();
    this.renderAreaPreview();
    this.renderSelectionRings();
    this.renderContextEditor();
    this.renderInlineEditor();
    this.renderPreviewSwitch();
    this.renderHoverPreview();
    this.syncInspectCursor();
    this.positionDock();
    if (focusToken) queueMicrotask(() => this.root.querySelector(`[data-focus-token="${CSS.escape(focusToken)}"]`)?.focus());
  }

  resolve(target) {
    const resolved = this.textPreview ? this.textPreview.resolve(target) : resolveTarget(target);
    const displayed = this.textPreview?.displayedRange?.(target);
    const measured = displayed ? displayed.getBoundingClientRect() : null;
    const textRect = measured && (measured.width || measured.height) ? measured : null;
    return { ...resolved, textRect, textPreviewActive: [...(this.previewStatuses?.values() || [])].includes("applied") };
  }

  previewItems() {
    if (!this.open || this.tool) return [];
    return this.data.annotations.filter((item) => {
      if (!item.target?.suggestion) return false;
      if (this.notePreview?.id === item.id) return this.notePreview.mode === "proposed";
      return this.previewMode === "proposed";
    });
  }

  updateTextPreview() {
    if (!this.textPreview) return;
    this.textPreview.restore();
    this.inlineAnchor = null;
    if (this.open && this.activeTarget && this.replacementOpen && this.writable()) {
      const range = this.textPreview.range(this.activeTarget);
      const resolved = this.resolve(this.activeTarget);
      if (range && resolved.status === "verified") {
        const rect = range.getBoundingClientRect();
        this.inlineAnchor = { rect, element: resolved.element };
      }
      this.previewStatuses = this.textPreview.apply(this.draftOriginal ? [] : [{ id: "draft", target: {
        ...this.activeTarget, suggestion: suggestion(this.activeTarget.text.quote, this.draftReplacement),
      } }]);
      const displayed = this.textPreview.displayedRange?.(this.activeTarget);
      const displayedRect = displayed?.getBoundingClientRect();
      // Deleting all text can leave a zero-sized Range at (0,0). Keep a usable
      // original insertion point so the reviewer can type again before saving.
      if (displayedRect?.height && this.inlineAnchor) this.inlineAnchor.rect = displayedRect;
    } else this.previewStatuses = this.textPreview.apply(this.previewItems());
  }

  setPreviewMode(mode) {
    this.previewMode = mode;
    this.notePreview = null;
    this.render();
  }

  renderPreviewSwitch() {
    if (this.tool || !this.data.annotations.some((item) => item.target?.suggestion && (!item.target.route || item.target.route === location.pathname))) return;
    const controls = node("div", { className: "preview-switch", role: "group" });
    controls.setAttribute("aria-label", "Page text preview");
    controls.append(node("span", { textContent: "Page" }));
    for (const mode of ["original", "proposed"]) {
      const control = button(mode === "original" ? "Original" : "Proposed", () => this.setPreviewMode(mode));
      control.setAttribute("aria-pressed", String(this.previewMode === mode));
      control.dataset.focusToken = `page-${mode}`;
      controls.append(control);
    }
    if (this.notePreview) controls.append(button("Reset note comparison", () => { this.notePreview = null; this.render(); }));
    const skipped = [...this.previewStatuses.values()].filter((status) => !["applied", "other-route"].includes(status)).length;
    if (skipped) controls.append(node("span", { className: "preview-warning", textContent: `${skipped} not previewed — see Notes`, role: "status" }));
    this.root.append(controls);
  }

  startInlineEdit() {
    this.textPreview?.restore();
    if (!this.textPreview?.range(this.activeTarget)) {
      this.notice = "This text cannot be edited safely here. You can still leave a comment or select a different text location.";
      this.panelOpen = true;
      this.render();
      return;
    }
    if (!this.replacementOpen) this.draftReplacement = this.activeTarget.text.quote;
    this.replacementOpen = true;
    this.draftOriginal = false;
    window.getSelection()?.removeAllRanges();
    this.ensureInlineVisible();
    this.render();
    queueMicrotask(() => this.root.querySelector('[data-focus-token="inline-text"]')?.focus());
  }

  renderInlineEditor() {
    if (!this.inlineAnchor || !this.replacementOpen || this.draftOriginal || !this.writable()) return;
    const { rect, element } = this.inlineAnchor;
    const style = getComputedStyle(element);
    const viewport = window.visualViewport || { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 };
    const input = node("textarea", { className: "inline-text", value: this.draftReplacement, spellcheck: true, rows: 1 });
    input.setAttribute("aria-label", "Edit selected text inline");
    input.dataset.focusToken = "inline-text";
    input.maxLength = 1000;
    let background = style.backgroundColor;
    for (let parent = element.parentElement; parent && (!background || background === "rgba(0, 0, 0, 0)" || background === "transparent"); parent = parent.parentElement) background = getComputedStyle(parent).backgroundColor;
    const left = clamp(rect.x - (viewport.offsetLeft || 0), 4, Math.max(4, viewport.width - 84));
    Object.assign(input.style, {
      left: `${left}px`, top: `${rect.y - (viewport.offsetTop || 0)}px`,
      width: `${Math.min(Math.max(80, rect.width + 4), viewport.width - left - 4)}px`,
      fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
      fontStyle: style.fontStyle, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
      textAlign: style.textAlign, color: style.color, backgroundColor: background === "rgba(0, 0, 0, 0)" ? "white" : background,
    });
    input.addEventListener("input", () => {
      this.draftReplacement = input.value;
      this.updateTextPreview();
      this.positionInlineInput(input);
      const editor = this.root.querySelector('.context-card');
      if (editor) this.positionContextEditor(editor);
      this.scheduleOverlayUpdate();
    });
    input.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); this.commit(); }
    });
    this.root.append(input);
    this.positionInlineInput(input);
  }

  ensureInlineVisible() {
    const resolved = this.resolve(this.activeTarget);
    if (resolved.status !== "verified") return;
    const rect = resolved.element.getBoundingClientRect();
    const height = window.visualViewport?.height || innerHeight;
    if (rect.top < 100 || rect.bottom > height * (innerWidth <= 600 ? .4 : .85)) {
      window.scrollBy({ top: rect.top - Math.min(120, height * .2), behavior: "instant" });
    }
  }

  positionInlineInput(input) {
    if (!this.inlineAnchor) return;
    const { rect, element } = this.inlineAnchor;
    const viewport = window.visualViewport || { width: innerWidth, offsetLeft: 0, offsetTop: 0 };
    const left = clamp(rect.x - (viewport.offsetLeft || 0), 4, Math.max(4, viewport.width - 84));
    const available = Math.min(element.getBoundingClientRect().right - rect.x, viewport.width - left - 4);
    const width = Math.max(40, Math.min(Math.max(80, rect.width + 8), available));
    Object.assign(input.style, { left: `${left}px`, top: `${rect.y - (viewport.offsetTop || 0)}px`, width: `${width}px` });
    // Measure without a temporary scrollbar stealing width and wrapping a line.
    input.style.overflowY = "hidden";
    input.style.height = "1px";
    const limit = (window.visualViewport?.height || innerHeight) * .45;
    const height = Math.max(parseFloat(getComputedStyle(input).lineHeight) || 24, input.scrollHeight);
    input.style.height = `${Math.min(height, limit)}px`;
    input.style.overflowY = height > limit ? "auto" : "hidden";
  }

  renderLauncher() {
    const launcher = node("button", { type: "button", className: "launcher", title: "Open UI Review · E: annotate · T: text · Esc: cancel" });
    launcher.setAttribute("aria-keyshortcuts", "E T");
    launcher.dataset.focusToken = "launcher";
    launcher.setAttribute("aria-label", `Open UI Review, ${this.data.annotations.length} notes`);
    launcher.append(svgIcon(icons.annotate));
    if (this.data.annotations.length) launcher.append(node("span", { className: "count", textContent: this.data.annotations.length }));
    launcher.addEventListener("click", () => this.launch());
    this.bindDockDrag(launcher, launcher);
    this.root.append(launcher);
  }

  renderToolbar() {
    const bar = node("div", { className: "bar", role: "toolbar" });
    bar.setAttribute("aria-label", "UI Review toolbar");
    const grip = node("button", { type: "button", className: "drag-grip", textContent: "⠿", title: "Drag to move · Arrow keys move · Home resets" });
    grip.setAttribute("aria-label", "Move UI Review");
    grip.dataset.focusToken = "toolbar-move";
    bar.append(grip);
    this.bindDockDrag(grip, bar);
    if (this.writable()) {
      const annotateActive = ["inspect", "element", "text"].includes(this.tool);
      const annotate = iconButton("Element (E) — click an element or select text", icons.annotate, () => this.beginTool("inspect"), annotateActive ? "active" : "");
      annotate.setAttribute("aria-keyshortcuts", "E");
      annotate.setAttribute("aria-pressed", String(annotateActive));
      annotate.title = annotate.dataset.tooltip = "Element (E) · Esc to stop";
      bar.append(annotate);
      bar.append(iconButton(this.pausedActive ? "Resume animations" : "Pause animations", icons.pause, () => this.togglePause(), this.pausedActive ? "active" : ""));
      const advanced = iconButton("Advanced selection", icons.advanced, () => {
        this.advancedOpen = !this.advancedOpen;
        const opening = this.advancedOpen;
        this.moreOpen = false;
        if (this.advancedOpen) {
          this.panelOpen = false;
          this.showHint = false;
        }
        this.render();
        if (opening) focusFirstVisible(this.root, '.menu[aria-label="Advanced selection tools"] button');
      }, this.advancedOpen || ["area", "group", "layout"].includes(this.tool) ? "active" : "");
      advanced.dataset.focusToken = "toolbar-advanced";
      bar.append(advanced);
    }
    bar.append(iconButton(this.markersVisible ? "Hide markers" : "Show markers", icons.markers, () => {
      this.markersVisible = !this.markersVisible;
      this.render();
    }, this.markersVisible ? "active" : ""));
    const notes = iconButton(`Notes — ${this.data.annotations.length} comments`, icons.notes, () => {
      this.clusterIds = null;
      const opening = !this.panelOpen;
      this.panelOpen = opening;
      if (opening && !this.activeTarget) {
        this.tool = null;
        this.group = [];
        this.groupReady = false;
        this.layout = null;
        this.clearHover();
      }
      this.advancedOpen = false;
      this.moreOpen = false;
      this.render();
    }, this.panelOpen ? "active" : "");
    if (this.data.annotations.length) notes.append(node("span", { className: "count", textContent: this.data.annotations.length }));
    bar.append(notes);
    const more = iconButton("More", icons.more, () => {
      this.moreOpen = !this.moreOpen;
      const opening = this.moreOpen;
      this.advancedOpen = false;
      if (this.moreOpen) this.panelOpen = false;
      this.render();
      if (opening) focusFirstVisible(this.root, '.menu[aria-label="More review actions"] button');
    }, this.moreOpen ? "active" : "");
    more.dataset.focusToken = "toolbar-more";
    bar.append(more);
    bar.append(node("span", { className: "divider", ariaHidden: "true" }));
    bar.append(iconButton("Close UI Review", icons.close, () => this.close(), "danger"));
    if (this.save === "Offline") bar.append(node("span", { className: "offline", textContent: "Offline", ariaLive: "polite" }));
    else {
      const status = node("span", { className: `save-check ${this.save === "Saving" ? "saving" : ""}` });
      status.setAttribute("aria-label", this.save || "Ready");
      status.setAttribute("role", "status");
      bar.append(status);
    }
    this.root.append(bar);
  }

  positionDock() {
    if (!this.dockPosition || !this.root) return;
    const viewport = window.visualViewport || { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 };
    const dock = this.root.querySelector(".bar,.launcher");
    if (!dock) return;
    const position = clampDockPosition(this.dockPosition, { width: dock.offsetWidth, height: dock.offsetHeight }, viewport);
    Object.assign(dock.style, { right: `${position.right}px`, bottom: `${position.bottom}px` });
    const dockBox = dock.getBoundingClientRect();
    const x = dockBox.x - (viewport.offsetLeft || 0);
    const y = dockBox.y - (viewport.offsetTop || 0);
    for (const popup of this.root.querySelectorAll(".menu,.panel,.selection-hud")) {
      popup.style.maxWidth = `${viewport.width - 16}px`;
      const box = popup.getBoundingClientRect();
      const left = clamp(x + dockBox.width - box.width, 8, Math.max(8, viewport.width - box.width - 8));
      const above = y - box.height - 10;
      const top = clamp(above >= 8 ? above : y + dockBox.height + 10, 8, Math.max(8, viewport.height - box.height - 8));
      Object.assign(popup.style, { left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" });
    }
  }

  saveDockPosition() {
    try { localStorage.setItem("ui-review-next:dock-position", JSON.stringify(this.dockPosition)); } catch { /* Moving still works when storage is unavailable. */ }
  }

  bindDockDrag(handle, dock) {
    let start = null;
    let moved = false;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      const viewport = window.visualViewport || { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 };
      const box = dock.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, right: viewport.width - box.right + (viewport.offsetLeft || 0), bottom: viewport.height - box.bottom + (viewport.offsetTop || 0) };
      moved = false;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true;
      this.draggingDock = true;
      event.preventDefault();
      const viewport = window.visualViewport || { width: innerWidth, height: innerHeight };
      this.dockPosition = clampDockPosition({ right: start.right - dx, bottom: start.bottom - dy }, { width: dock.offsetWidth, height: dock.offsetHeight }, viewport);
      this.positionDock();
    });
    const stop = () => { start = null; this.draggingDock = false; if (moved) this.saveDockPosition(); };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("lostpointercapture", stop);
    handle.addEventListener("click", (event) => {
      if (!moved) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      moved = false;
    }, true);
    handle.addEventListener("keydown", (event) => {
      const steps = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (event.key !== "Home" && !steps[event.key]) return;
      event.preventDefault();
      if (event.key === "Home") {
        this.dockPosition = null;
        this.saveDockPosition();
        this.render();
        return;
      }
      const viewport = window.visualViewport || { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 };
      const box = dock.getBoundingClientRect();
      const step = event.shiftKey ? 40 : 10;
      this.dockPosition = clampDockPosition({ right: viewport.width - box.right + (viewport.offsetLeft || 0) + steps[event.key][0] * step,
        bottom: viewport.height - box.bottom + (viewport.offsetTop || 0) + steps[event.key][1] * step }, { width: dock.offsetWidth, height: dock.offsetHeight }, viewport);
      this.positionDock();
      this.saveDockPosition();
    });
  }

  menuItem(label, description, handler, className = "") {
    const control = button(label, handler, className);
    control.setAttribute("aria-label", label);
    control.setAttribute("role", "menuitem");
    control.append(node("small", { textContent: description }));
    return control;
  }

  renderAdvancedMenu() {
    const menu = node("div", { className: "menu", role: "menu" });
    menu.setAttribute("aria-label", "Advanced selection tools");
    menu.append(this.menuItem("Element", "Tap one item", () => this.beginTool("element"), "mobile-only"));
    const textTool = this.menuItem("Text (T)", "Select existing words", () => this.beginTool("text"));
    textTool.setAttribute("aria-keyshortcuts", "T");
    menu.append(textTool);
    menu.append(this.menuItem("Area", "Draw a rectangle", () => this.beginTool("area")));
    menu.append(this.menuItem("Multi-select", "Choose several items", () => this.beginTool("group")));
    menu.append(this.menuItem("Layout", "Relate two items", () => this.beginTool("layout"), "desktop-only"));
    this.root.append(menu);
  }

  renderMoreMenu() {
    const menu = node("div", { className: "menu", role: "menu" });
    menu.setAttribute("aria-label", "More review actions");
    if (this.writable()) {
      const keep = this.menuItem("Keep annotating", this.keepAnnotating ? "On · select again after saving" : "Off · browse after saving", () => {
        this.keepAnnotating = !this.keepAnnotating;
        try { localStorage.setItem("ui-review-next:keep-annotating", String(this.keepAnnotating)); } catch { /* The toggle still works for this tab. */ }
        this.render();
      });
      keep.setAttribute("role", "menuitemcheckbox");
      keep.setAttribute("aria-checked", String(this.keepAnnotating));
      keep.dataset.focusToken = "keep-annotating";
      menu.append(keep);
    }
    if (this.writable()) menu.append(this.menuItem("Finish review", "Close for comments", () => this.finish()));
    menu.append(this.menuItem("Collapse", "Keep the launcher", () => this.close()));
    this.root.append(menu);
  }

  renderPanel(listScroll) {
    const panel = node("section", { className: "panel" });
    panel.setAttribute("aria-label", "UI Review comments");
    const title = node("div");
    title.append(node("h2", { textContent: "UI Review" }));
    if (this.data.session?.title) title.append(node("div", { className: "subtle", textContent: this.data.session.title }));
    const dismiss = iconButton("Close notes", icons.close, () => {
      this.panelOpen = false;
      this.clusterIds = null;
      this.render();
    });
    panel.append(node("div", { className: "head" }, [title, dismiss]));

    if (this.notice) {
      const notice = node("div", { className: "notice", textContent: this.notice });
      if (this.pendingLocation) notice.append(button("Open location", () => this.openLocation(), "primary"));
      if (this.conflictQueueId) {
        notice.append(button("Retry queued change", () => this.retryQueued(), "primary"));
        notice.append(button("Discard queued change", () => this.discardQueued()));
      }
      panel.append(notice);
    }
    if (this.needsPasscode) {
      const form = node("form", { className: "editor" });
      const passcode = node("input", { type: "password", placeholder: "Optional review passcode", autocomplete: "current-password" });
      passcode.setAttribute("aria-label", "Review passcode");
      form.append(passcode, button("Try passcode", () => {
        this.api.setPasscode(passcode.value);
        this.notice = "";
        this.load();
      }, "primary"));
      form.addEventListener("submit", (event) => event.preventDefault());
      panel.append(form);
    }
    if (this.failedDraft) {
      const recovery = node("div", { className: "notice" });
      recovery.append(node("div", { textContent: `Unsaved comment: ${this.failedDraft.draftComment}` }));
      if (this.failedDraft.draftReplacement) recovery.append(node("div", { textContent: `Replacement: ${this.failedDraft.draftReplacement}` }));
      recovery.append(button("Restore unsaved comment", () => this.restoreDraft(), "primary"));
      recovery.append(button("Discard unsaved comment", () => { this.failedDraft = null; this.render(); }));
      panel.append(recovery);
    }
    if (["finished", "archived", "expired"].includes(this.data.session?.status)) {
      panel.append(node("div", { className: "notice", textContent: "This review is closed. Ask the builder to reopen it with a new link." }));
    }
    if (this.clusterIds) panel.append(node("div", { className: "hint", textContent: `${this.clusterIds.length} notes share this location. Choose one below.` }));

    const annotations = this.clusterIds ? this.data.annotations.filter((item) => this.clusterIds.includes(item.id)) : this.data.annotations;
    const list = node("div", { className: "list", tabIndex: 0 });
    list.dataset.focusToken = "notes-list";
    if (!annotations.length) list.append(node("div", { className: "empty", textContent: "No comments yet. Select Annotate, then click an element or select text." }));
    for (const annotation of annotations) {
      const number = this.data.annotations.findIndex((item) => item.id === annotation.id) + 1;
      list.append(this.row(annotation, number));
    }
    panel.append(list);
    this.root.append(panel);
    if (listScroll != null) list.scrollTop = listScroll;
  }

  row(annotation, number) {
    const selected = annotation.id === this.selectedId;
    const row = node("article", { className: `row ${selected ? "selected" : ""}`, tabIndex: 0 });
    row.setAttribute("aria-label", `Note ${number}: ${annotation.comment || "Untitled"}`);
    row.dataset.annotationId = annotation.id;
    row.dataset.focusToken = `row-${annotation.id}`;
    row.append(node("span", { className: "number", textContent: number }));
    const content = node("div");
    content.append(node("div", { className: "body", textContent: annotation.comment || "" }));
    content.append(node("div", { className: "state", textContent: String(annotation.state || "open").replaceAll("_", " ") }));
    if (selected) {
      for (const reply of annotation.replies || []) content.append(node("div", { className: "reply", textContent: `Reply: ${reply.text || ""}` }));
      if (annotation.fixSummary) content.append(node("div", { className: "fix", textContent: `Fix summary: ${annotation.fixSummary}` }));
      const controls = node("div", { className: "actions" });
      if (this.writable()) controls.append(button("Edit", () => this.beginEdit(annotation)));
      if (this.writable() && this.resolve(annotation.target).status === "changed") controls.append(button("Retarget", () => this.beginRetarget(annotation)));
      if (annotation.target?.suggestion) {
        const comparison = node("div", { className: "text-comparison" });
        comparison.append(node("div", { textContent: `Original: ${annotation.target.suggestion.before}` }));
        comparison.append(node("div", { textContent: `Proposed: ${annotation.target.suggestion.after || "(delete selected text)"}` }));
        content.append(comparison);
        const mode = this.notePreview?.id === annotation.id ? this.notePreview.mode : this.previewMode;
        for (const choice of ["original", "proposed"]) {
          const control = button(`This edit: ${choice}`, () => { this.notePreview = { id: annotation.id, mode: choice }; this.render(); });
          control.setAttribute("aria-pressed", String(mode === choice));
          control.dataset.focusToken = `note-${annotation.id}-${choice}`;
          controls.append(control);
        }
      }
      content.append(controls);
    }
    const previewStatus = this.previewStatuses?.get(annotation.id);
    if (previewStatus && !["applied", "other-route"].includes(previewStatus)) content.append(node("div", {
      className: "preview-warning", textContent: previewStatus === "conflict" ? "Overlapping suggestions — not previewed together." : "Preview unavailable — text changed or this target is not safe to edit.",
    }));
    row.append(content);
    row.addEventListener("mouseenter", () => this.highlight(annotation));
    row.addEventListener("mouseleave", () => this.clearHighlight());
    row.addEventListener("focusin", () => this.highlight(annotation));
    row.addEventListener("focusout", (event) => {
      if (!row.contains(event.relatedTarget)) this.clearHighlight();
    });
    row.addEventListener("click", (event) => {
      if (!event.target.closest?.("button,input,textarea,select,a")) this.select(annotation.id, false, true);
    });
    row.addEventListener("keydown", (event) => {
      if (event.target === row && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        this.select(annotation.id, false, true);
      }
    });
    return row;
  }

  renderSelectionHud() {
    if (!this.writable()) return;
    if (this.tool === "group" && !this.groupReady) {
      const hud = node("div", { className: "selection-hud", role: "status" });
      hud.append(node("span", { textContent: `${this.group.length} selected` }));
      hud.append(button("Done", () => {
        if (this.group.length < 2) {
          this.notice = "Select at least two different elements.";
          this.panelOpen = true;
          this.render();
          return;
        }
        this.groupReady = true;
        this.activeTarget = { ...this.group[0], group: structuredClone(this.group) };
        this.render();
      }, "primary"));
      hud.append(button("Cancel", () => this.cancelTool()));
      this.root.append(hud);
      return;
    }
    if (this.tool === "layout" && this.layout?.sourceTarget && !this.layout.destinationTarget) {
      this.root.append(node("div", { className: "selection-hud", textContent: "Now choose where it should go" }));
      return;
    }
    if (this.showHint && ["inspect", "element", "text"].includes(this.tool) && !this.activeTarget) {
      this.root.append(node("div", { className: "selection-hud hint-toast", textContent: this.tool === "text" ? "Select existing words" : "Click an element or select text" }));
    }
  }

  renderContextEditor() {
    if (!this.writable() || !this.tool || !this.activeTarget || this.areaDrawing || (this.tool === "group" && !this.groupReady) || (this.tool === "layout" && !this.layout?.destinationTarget && !this.retarget)) return;
    const editor = this.editor();
    editor.classList.add("context-card");
    this.root.append(editor);
    this.positionContextEditor(editor);
  }

  positionContextEditor(editor) {
    const viewport = window.visualViewport || { width: innerWidth, height: innerHeight };
    const width = Math.min(286, viewport.width - 24);
    const box = editor.getBoundingClientRect();
    const resolved = this.resolve(this.activeTarget);
    const target = (this.replacementOpen && resolved.status === "verified" ? rectOf(resolved.element) : targetRect(this.activeTarget, resolved.status === "verified" ? resolved : null)) || this.activeTarget.rect || { x: viewport.width / 2, y: viewport.height / 2, width: 1, height: 1 };
    let x;
    let y = clamp(target.y, 12, Math.max(12, viewport.height - box.height - 12));
    if (target.x + target.width + 12 + width <= viewport.width - 12) x = target.x + target.width + 12;
    else if (target.x - width - 12 >= 12) x = target.x - width - 12;
    else {
      x = clamp(target.x, 12, Math.max(12, viewport.width - width - 12));
      y = target.y + target.height + 12 + box.height <= viewport.height ? target.y + target.height + 12 : Math.max(12, target.y - box.height - 12);
    }
    Object.assign(editor.style, { left: `${x}px`, top: `${y}px` });
  }

  editor() {
    const editor = node("form", { className: "editor" });
    editor.append(node("div", { className: "target-line", textContent: this.retarget ? `Editing · ${labelForTarget(this.activeTarget)}` : labelForTarget(this.activeTarget) }));
    if (this.activeTarget?.text?.quote) editor.append(node("div", { className: "quote", textContent: `“${this.activeTarget.text.quote}”` }));
    const comment = node("textarea", { placeholder: "What should change?", value: this.draftComment });
    comment.setAttribute("aria-label", "Comment");
    comment.dataset.focusToken = "editor-comment";
    comment.addEventListener("input", () => { this.draftComment = comment.value; });
    editor.append(comment);

    if (this.activeTarget?.text?.quote) {
      if (!this.replacementOpen) {
        editor.append(button("Edit text inline", () => {
          this.draftComment = comment.value;
          this.startInlineEdit();
        }, "disclosure"));
      } else {
        comment.placeholder = "Comment (optional)";
        editor.append(node("div", { className: "inline-hint", textContent: this.inlineAnchor ? "Type directly over the selected words. Changes are a preview only." : "Text location changed. Your draft is kept; retarget to preview it." }));
        const compare = node("div", { className: "actions" });
        for (const original of [true, false]) {
          const control = button(original ? "Original" : "Proposed", () => {
            this.draftOriginal = original;
            this.render();
            if (!original) queueMicrotask(() => this.root.querySelector('[data-focus-token="inline-text"]')?.focus());
          });
          control.setAttribute("aria-pressed", String(Boolean(this.draftOriginal) === original));
          compare.append(control);
        }
        compare.append(button("Remove text suggestion", () => { this.replacementOpen = false; this.draftReplacement = ""; this.render(); }));
        editor.append(compare);
      }
    }

    const actions = node("div", { className: "actions" });
    actions.append(button(this.retarget ? "Save changes" : "Add", () => {
      this.draftComment = comment.value;
      this.commit();
    }, "primary"));
    actions.append(button("Cancel", () => this.cancelTool()));
    editor.append(actions);
    editor.addEventListener("submit", (event) => event.preventDefault());
    editor.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        this.draftComment = comment.value;
        this.commit();
      }
    });
    return editor;
  }

  beginTool(tool, retarget = null) {
    if (this.save === "Saving") return;
    this.textPreview?.restore();
    this.notePreview = null;
    this.draftOriginal = false;
    this.open = true;
    this.selectedId = null;
    this.highlightedId = null;
    if (tool === "layout" && innerWidth <= 600) {
      this.notice = "Layout is available on desktop. Element, Text, Area, and Multi-select work here.";
      this.panelOpen = true;
      this.advancedOpen = false;
      this.render();
      return;
    }
    this.toolFocus = this.shadow.activeElement || document.activeElement;
    this.open = true;
    this.tool = tool;
    this.retarget = retarget;
    this.selectedId = retarget?.id || this.selectedId;
    this.activeTarget = null;
    this.group = [];
    this.groupReady = false;
    this.layout = null;
    this.areaStart = null;
    this.areaDrawing = false;
    this.advancedOpen = false;
    this.moreOpen = false;
    this.panelOpen = false;
    this.notice = "";
    this.pendingLocation = null;
    this.draftComment = retarget?.comment || "";
    this.draftReplacement = retarget?.target?.suggestion?.after || "";
    this.replacementOpen = Boolean(retarget?.target?.suggestion);
    this.clearHover();
    this.render();
  }

  beginEdit(annotation) {
    const tool = annotation.type === "element" ? "inspect" : annotation.type === "pause" ? "element" : annotation.type;
    this.beginTool(tool, annotation);
    this.activeTarget = structuredClone(annotation.target);
    this.group = Array.isArray(annotation.target?.group) ? structuredClone(annotation.target.group) : [];
    this.groupReady = annotation.type === "group";
    if (annotation.type === "layout") this.layout = { instruction: structuredClone(annotation.target.layout), destinationTarget: structuredClone(annotation.target.layout?.destinationTarget) };
    if (this.replacementOpen) this.ensureInlineVisible();
    this.render();
    queueMicrotask(() => this.root.querySelector(this.replacementOpen ? '[data-focus-token="inline-text"]' : '[data-focus-token="editor-comment"]')?.focus({ preventScroll: true }));
  }

  beginRetarget(annotation) {
    const tool = annotation.type === "element" || annotation.type === "pause" ? "inspect" : annotation.type;
    this.beginTool(tool, annotation);
    this.notice = annotation.type === "text" ? "Select the intended words again." : "Select the intended location again.";
    this.render();
  }

  cancelTool() {
    const focus = this.toolFocus;
    this.close();
    queueMicrotask(() => focus?.focus?.());
  }

  selectionActive() {
    if (!this.open || !this.writable()) return false;
    if (["inspect", "element", "text", "area"].includes(this.tool)) return !this.activeTarget || this.areaDrawing;
    if (this.tool === "group") return !this.groupReady;
    if (this.tool === "layout") return !this.layout?.destinationTarget;
    return false;
  }

  syncInspectCursor() {
    document.documentElement.classList.toggle("ui-review-next-inspecting", this.selectionActive());
  }

  capturePointerDown(event) {
    if (this.isReviewEvent(event)) return;
    if (this.advancedOpen || this.moreOpen) {
      this.advancedOpen = false;
      this.moreOpen = false;
      this.render();
    }
    if (this.tool !== "area" || !this.selectionActive()) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === this.host || this.host.contains(element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.showHint = false;
    this.areaStart = { x: event.clientX, y: event.clientY };
    this.areaDrawing = true;
    this.activeTarget = {
      ...plainTarget(element),
      area: {
        ...areaFromPoints(this.areaStart, this.areaStart, { width: innerWidth, height: innerHeight }),
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    };
    this.render();
  }

  capturePointerMove(event) {
    if (this.tool === "area" && this.areaDrawing && this.areaStart && this.activeTarget?.area) {
      event.preventDefault();
      this.activeTarget.area = {
        ...areaFromPoints(this.areaStart, { x: event.clientX, y: event.clientY }, { width: innerWidth, height: innerHeight }),
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      };
      this.renderAreaPreview(true);
      return;
    }
    if (!this.selectionActive() || innerWidth <= 600) {
      this.clearHover();
      return;
    }
    this.pendingHover = { x: event.clientX, y: event.clientY };
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const pointer = this.pendingHover;
      const element = document.elementFromPoint(pointer.x, pointer.y);
      if (!element || element === this.host || this.host.contains(element)) {
        this.clearHover();
        return;
      }
      this.hoverElement = element;
      this.hoverRect = rectOf(element);
      this.hoverLabel = labelFor(element);
      this.pointer = pointer;
      this.renderHoverPreview();
    });
  }

  capturePointerUp(event) {
    if (this.tool === "area" && this.areaDrawing) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.areaDrawing = false;
      this.areaStart = null;
      this.suppressUpcomingClick();
      this.clearHover();
      this.render();
      queueMicrotask(() => this.root.querySelector('[data-focus-token="editor-comment"]')?.focus());
      return;
    }
    if (!["inspect", "text"].includes(this.tool) || this.activeTarget) return;
    if (this.captureTextSelection()) {
      this.suppressUpcomingClick();
      event.stopImmediatePropagation();
    }
  }

  suppressUpcomingClick() {
    clearTimeout(this.suppressClickTimer);
    this.suppressClickOnce = true;
    this.suppressClickTimer = window.setTimeout(() => {
      this.suppressClickOnce = false;
    }, 0);
  }

  captureClick(event) {
    if (this.isReviewEvent(event) || !this.selectionActive()) return;
    if (this.suppressClickOnce) {
      this.suppressClickOnce = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === this.host || this.host.contains(element)) return;
    if (this.tool === "text") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!["inspect", "element", "group", "layout"].includes(this.tool)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.showHint = false;
    if (this.tool === "group") this.selectGroupMember(element);
    else if (this.tool === "layout") this.selectLayoutTarget(element);
    else {
      this.activeTarget = plainTarget(element);
      this.notice = "";
      this.clearHover();
      this.render();
      queueMicrotask(() => this.root.querySelector('[data-focus-token="editor-comment"]')?.focus());
    }
  }

  captureTextSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim() || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const element = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
    if (!element || this.host.contains(element)) return false;
    const target = targetFor(element);
    if (!target.text?.quote) return false;
    const exact = unionRects([...range.getClientRects()]);
    if (exact) target.rect = { ...exact, viewport: { width: innerWidth, height: innerHeight } };
    this.activeTarget = target;
    this.tool = "text";
    this.showHint = false;
    this.notice = "";
    this.clearHover();
    this.render();
    queueMicrotask(() => this.root.querySelector('[data-focus-token="editor-comment"]')?.focus());
    return true;
  }

  selectGroupMember(element) {
    const candidate = plainTarget(element);
    const existing = this.group.findIndex((item) => item.selector === candidate.selector);
    if (existing >= 0) this.group.splice(existing, 1);
    else this.group.push(candidate);
    this.activeTarget = this.group.length ? { ...this.group[0], group: structuredClone(this.group) } : null;
    this.clearHover();
    this.render();
  }

  selectLayoutTarget(element) {
    const candidate = plainTarget(element);
    if (!this.layout?.sourceTarget) {
      this.layout = { sourceElement: element, sourceTarget: candidate, destinationTarget: null, instruction: null };
      this.activeTarget = candidate;
      this.clearHover();
      this.render();
      return;
    }
    if (candidate.selector === this.layout.sourceTarget.selector) {
      this.notice = "Choose a different destination.";
      this.panelOpen = true;
      this.render();
      return;
    }
    const sourceRect = this.layout.sourceElement?.getBoundingClientRect?.() || this.layout.sourceTarget.rect;
    const destinationRect = element.getBoundingClientRect();
    const placement = destinationRect.x + destinationRect.width / 2 < sourceRect.x + sourceRect.width / 2 ? "before" : "after";
    this.layout.destinationElement = element;
    this.layout.destinationTarget = candidate;
    this.layout.instruction = { intent: "rearrange", dx: 0, dy: 0, destinationSelector: candidate.selector, destinationTarget: structuredClone(candidate), placement };
    this.activeTarget = { ...this.layout.sourceTarget, layout: structuredClone(this.layout.instruction) };
    this.clearHover();
    this.render();
    queueMicrotask(() => this.root.querySelector('[data-focus-token="editor-comment"]')?.focus());
  }

  clearHover() {
    this.hoverElement = null;
    this.hoverRect = null;
    this.hoverLabel = null;
    this.pointer = null;
    if (!this.root) return;
    for (const item of this.root.querySelectorAll(".hover-ring,.hover-label,.pointer-plus")) item.remove();
  }

  renderHoverPreview() {
    if (!this.root) return;
    for (const item of this.root.querySelectorAll(".hover-ring,.hover-label,.pointer-plus")) item.remove();
    if (!this.selectionActive() || !this.hoverRect || !this.pointer || innerWidth <= 600) return;
    const ring = node("div", { className: "hover-ring", ariaHidden: "true" });
    setRect(ring, this.hoverRect);
    const label = node("div", { className: "hover-label", textContent: this.hoverLabel, ariaHidden: "true" });
    Object.assign(label.style, {
      left: `${clamp(this.hoverRect.x, 6, innerWidth - 246)}px`,
      top: `${Math.max(6, this.hoverRect.y - 25)}px`,
    });
    const pointer = node("div", { className: "pointer-plus", textContent: "+", ariaHidden: "true" });
    Object.assign(pointer.style, { left: `${this.pointer.x}px`, top: `${this.pointer.y}px` });
    this.root.append(ring, label, pointer);
  }

  renderAreaPreview(updateOnly = false) {
    const area = this.activeTarget?.area;
    let preview = this.root.querySelector(".area-preview");
    if (!area) {
      preview?.remove();
      return;
    }
    if (!preview) {
      preview = node("div", { className: "area-preview", ariaHidden: "true" });
      this.root.append(preview);
    }
    setRect(preview, area);
    if (!updateOnly) preview.dataset.ready = String(!this.areaDrawing);
  }

  renderSelectionRings() {
    if (this.tool === "group") {
      for (const member of this.group) {
        const resolved = this.resolve(member);
        if (resolved.status !== "verified") continue;
        const ring = node("div", { className: "member-ring", ariaHidden: "true" });
        setRect(ring, targetRect(member, resolved));
        this.root.append(ring);
      }
    }
    if (this.tool === "layout" && this.layout?.sourceTarget) {
      const source = this.resolve(this.layout.sourceTarget);
      if (source.status === "verified") {
        const ring = node("div", { className: "layout-ring", ariaHidden: "true" });
        setRect(ring, targetRect(this.layout.sourceTarget, source));
        this.root.append(ring);
      }
      if (this.layout.destinationTarget) {
        const destination = this.resolve(this.layout.destinationTarget);
        if (destination.status === "verified") {
          const ring = node("div", { className: "layout-ring destination", ariaHidden: "true" });
          setRect(ring, targetRect(this.layout.destinationTarget, destination));
          this.root.append(ring);
        }
      }
    }
  }

  markerGroups() {
    const groups = new Map();
    const viewport = window.visualViewport || { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 };
    for (const annotation of this.data.annotations) {
      const resolved = this.resolve(annotation.target);
      if (resolved.status !== "verified") continue;
      const rect = targetRect(annotation.target, resolved);
      if (!rect) continue;
      const absolute = point(rect);
      const position = {
        x: clamp(absolute.x - (viewport.offsetLeft || 0), 16, viewport.width - 16),
        y: clamp(absolute.y - (viewport.offsetTop || 0), 16, viewport.height - 16),
      };
      const key = `${Math.round(position.x / 12)}:${Math.round(position.y / 12)}`;
      if (!groups.has(key)) groups.set(key, { position, annotations: [] });
      groups.get(key).annotations.push(annotation);
    }
    return [...groups.values()];
  }

  renderMarkers() {
    if (!this.open || !this.markersVisible) return;
    for (const group of this.markerGroups()) {
      const annotations = group.annotations;
      const ids = annotations.map((item) => item.id);
      const first = annotations[0];
      const number = this.data.annotations.findIndex((item) => item.id === first.id) + 1;
      const clustered = annotations.length > 1;
      const marker = button(clustered ? String(annotations.length) : String(number), () => {
        if (clustered) {
          this.clusterIds = ids;
          this.selectedId = null;
          this.open = true;
          this.panelOpen = true;
          this.render();
        } else this.select(first.id, true, true);
      });
      marker.className = `marker ${clustered ? "cluster" : ""} ${ids.includes(this.selectedId) || ids.includes(this.highlightedId) ? "highlight" : ""}`;
      marker.style.left = `${group.position.x}px`;
      marker.style.top = `${group.position.y}px`;
      marker.dataset.markerIds = JSON.stringify(ids);
      marker.title = clustered ? `${annotations.length} notes at this location` : `Note ${number}: ${(first.comment || "Untitled").slice(0, 80)}`;
      marker.setAttribute("aria-label", clustered ? `Open ${annotations.length} notes at this location` : `Open note ${number}`);
      this.root.append(marker);
    }
  }

  renderTargetRing() {
    for (const ring of this.root.querySelectorAll(".target-ring,.saved-target-ring")) ring.remove();
    if (!this.open || !this.markersVisible) return;
    const annotation = this.data.annotations.find((item) => item.id === (this.highlightedId || this.selectedId));
    const resolved = annotation && this.resolve(annotation.target);
    if (!annotation || !resolved || resolved.status !== "verified") return;
    const rect = targetRect(annotation.target, resolved);
    if (!rect) return;
    const destinationElement = (resolved as any).destinationElement;
    if (annotation.target?.layout?.destinationTarget && destinationElement) {
      const sourceRing = node("div", { className: "layout-ring saved-target-ring", ariaHidden: "true" });
      setRect(sourceRing, rectOf(resolved.element));
      const destinationRing = node("div", { className: "layout-ring destination saved-target-ring", ariaHidden: "true" });
      setRect(destinationRing, rectOf(destinationElement));
      this.root.append(sourceRing, destinationRing);
      return;
    }
    const ring = node("div", { className: "target-ring", ariaHidden: "true" });
    setRect(ring, rect);
    this.root.append(ring);
  }

  scheduleOverlayUpdate() {
    if (this.overlayFrame) return;
    this.overlayFrame = requestAnimationFrame(() => {
      this.overlayFrame = 0;
      for (const item of this.root.querySelectorAll(".marker,.target-ring,.area-preview,.member-ring,.layout-ring")) item.remove();
      if (this.markersVisible) this.renderMarkers();
      this.renderTargetRing();
      this.renderAreaPreview();
      this.renderSelectionRings();
      if (this.hoverElement) {
        this.hoverRect = rectOf(this.hoverElement);
        this.renderHoverPreview();
      }
    });
  }

  commit() {
    if (this.failedDraft) {
      this.notice = "Restore or discard your previous unsaved comment before saving another.";
      this.panelOpen = true;
      this.render();
      return;
    }
    if (!this.activeTarget) {
      this.notice = "Select a target first.";
      this.panelOpen = true;
      this.render();
      return;
    }
    const hasSuggestion = Boolean(this.activeTarget.text?.quote && (this.replacementOpen || this.draftReplacement) && this.draftReplacement !== this.activeTarget.text.quote);
    const comment = this.draftComment.trim() || (hasSuggestion ? "Suggested text change" : "");
    if (!comment) {
      this.notice = "Add a comment before saving.";
      this.panelOpen = true;
      this.render();
      return;
    }
    if (this.tool === "group" && this.group.length < 2) {
      this.notice = "Select at least two different elements.";
      this.panelOpen = true;
      this.render();
      return;
    }
    const target = structuredClone(this.activeTarget);
    let type = this.tool === "inspect" || this.tool === "element" ? (target.text?.quote ? "text" : "element") : this.tool;
    if (this.retarget?.type === "pause") type = "pause";
    if (type === "text" && hasSuggestion) target.suggestion = suggestion(target.text.quote, this.draftReplacement);
    else delete target.suggestion;
    if (this.pausedActive || type === "pause") target.pause = { action: "pause", animationCount: this.paused.length };
    if (type === "layout" && this.layout?.instruction) target.layout = structuredClone(this.layout.instruction);
    const existing = this.retarget;
    const operation = existing
      ? { kind: "update", annotationId: existing.id, update: { target, comment }, revision: existing.revision, baseRevision: this.data.session.revision }
      : { kind: "create", annotation: { type, comment, target }, revision: this.data.session.revision };
    const call = existing
      ? (id) => this.api.update(existing.id, { target, comment }, existing.revision, this.data.session.revision, id)
      : (id) => this.api.create({ type, comment, target }, this.data.session.revision, id);
    // Live Layout elements are for measuring only; DOM nodes cannot be structured-cloned.
    const layoutDraft = this.layout ? { sourceTarget: this.layout.sourceTarget,
      destinationTarget: this.layout.destinationTarget, instruction: this.layout.instruction } : null;
    const draft = structuredClone({ tool: this.tool, activeTarget: target, group: this.group,
      groupReady: this.groupReady, layout: layoutDraft, retarget: existing,
      draftComment: this.draftComment, draftReplacement: this.draftReplacement,
      replacementOpen: this.replacementOpen });
    if (target.text) globalThis.window?.getSelection?.()?.removeAllRanges();
    this.tool = null;
    this.activeTarget = null;
    this.group = [];
    this.groupReady = false;
    this.layout = null;
    this.retarget = null;
    this.draftComment = "";
    this.draftReplacement = "";
    this.replacementOpen = false;
    this.clearHover();
    this.mutate(operation, call, draft);
  }

  restoreDraft() {
    const draft = this.failedDraft;
    if (!draft || !this.writable()) return;
    const current = draft.retarget && this.data.annotations.find((item) => item.id === draft.retarget.id);
    if (draft.retarget && !current) {
      this.notice = "The original note is unavailable. Your unsaved comment is still kept here.";
      this.render();
      return;
    }
    this.beginTool(draft.tool, current || null);
    Object.assign(this, structuredClone(draft), { retarget: current || null, failedDraft: null });
    this.render();
    queueMicrotask(() => this.root.querySelector('[data-focus-token="editor-comment"]')?.focus());
  }

  async mutate(operation, call, draft = null) {
    const id = crypto.randomUUID();
    const interactionVersion = this.interactionVersion;
    this.save = "Saving";
    this.render();
    try {
      const result = await call(id);
      const item = result.annotation;
      if (item) {
        const index = this.data.annotations.findIndex((annotation) => annotation.id === item.id);
        if (index >= 0) this.data.annotations[index] = item;
        else this.data.annotations.push(item);
        this.selectedId = item.id;
      }
      if (result.sessionRevision && this.data.session) this.data.session.revision = result.sessionRevision;
      this.save = "Saved";
      if (this.interactionVersion !== interactionVersion) this.render();
      else if (this.keepAnnotating && draft?.tool && this.open) this.beginTool(draft.tool);
      else if (this.previewMode === "proposed" && this.open) { this.selectedId = null; this.panelOpen = false; this.render(); }
      else this.close();
    } catch (error) {
      if (!navigator.onLine || error instanceof TypeError) {
        this.outbox.add({ id, operation, createdAt: Date.now() });
        this.save = "Offline";
      } else if (error.status === 409) {
        this.failedDraft = draft;
        await this.load();
        this.save = null;
        this.notice = "This review changed elsewhere. Your unsaved comment is kept in this tab. Check the current notes below, then restore it to edit and save again.";
      } else {
        this.failedDraft = draft;
        this.save = null;
        this.notice = `${error.message}. Your unsaved comment is kept in this tab; restore it to try again.`;
      }
      this.panelOpen = true;
      this.render();
    }
  }

  async flush() {
    for (const queued of this.outbox.all()) {
      try {
        const operation = queued.operation;
        const sessionRevision = this.data.session?.revision ?? operation.baseRevision ?? operation.revision;
        const current = this.data.annotations.find((item) => item.id === operation.annotationId);
        const result = operation.kind === "create"
          ? await this.api.create(operation.annotation, sessionRevision, queued.id)
          : operation.kind === "finish"
            ? await this.api.finish(operation.revision, queued.id)
            : await this.api.update(operation.annotationId, operation.update, current?.revision ?? operation.revision, sessionRevision, queued.id);
        if (result.session) this.data.session = result.session;
        this.applyEvent({ annotation: result.annotation });
        if (result.sessionRevision && this.data.session) this.data.session.revision = result.sessionRevision;
        this.outbox.remove(queued.id);
        if (operation.kind === "finish") this.finishOperationId = null;
        this.conflictQueueId = null;
      } catch (error) {
        if (error.status === 409) {
          await this.load();
          this.save = null;
          this.conflictQueueId = queued.id;
          this.notice = "A queued change was not saved because this review changed elsewhere. Review the current note, then retry or discard this exact queued change.";
          this.panelOpen = true;
          this.render();
        }
        return;
      }
    }
    if (this.outbox.all().length === 0 && navigator.onLine) this.load();
  }

  retryQueued() {
    this.conflictQueueId = null;
    this.notice = "Retrying queued change against the current review.";
    this.render();
    this.flush();
  }

  discardQueued() {
    if (this.conflictQueueId) this.outbox.remove(this.conflictQueueId);
    this.conflictQueueId = null;
    this.notice = "Conflicting queued change discarded; the current server note is unchanged.";
    this.save = "Saved";
    this.render();
  }

  select(id, scrollToRow = false, showTarget = false) {
    this.selectedId = id;
    this.open = true;
    this.panelOpen = true;
    this.clusterIds = null;
    this.render();
    const annotation = this.data.annotations.find((item) => item.id === id);
    if (showTarget && annotation) this.show(annotation, false);
    if (scrollToRow) queueMicrotask(() => this.root.querySelector(`[data-annotation-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  highlight(annotation) {
    if (this.resolve(annotation.target).status !== "verified") return;
    this.highlightedId = annotation.id;
    for (const marker of this.root.querySelectorAll(".marker")) {
      const ids = JSON.parse(marker.dataset.markerIds || "[]");
      marker.classList.toggle("highlight", ids.includes(annotation.id) || ids.includes(this.selectedId));
    }
    this.root.querySelector(".target-ring")?.remove();
    this.renderTargetRing();
  }

  clearHighlight() {
    this.highlightedId = null;
    for (const marker of this.root.querySelectorAll(".marker")) {
      const ids = JSON.parse(marker.dataset.markerIds || "[]");
      marker.classList.toggle("highlight", ids.includes(this.selectedId));
    }
    this.root.querySelector(".target-ring")?.remove();
    this.renderTargetRing();
  }

  show(annotation, collapse = false) {
    const target = annotation.target;
    this.selectedId = annotation.id;
    if (locationAction(target, location.pathname) === "open-location") {
      this.notice = "This note is on another route.";
      this.pendingLocation = target.pageUrl;
      this.open = true;
      this.panelOpen = true;
      this.render();
      return;
    }
    const result = this.resolve(target);
    if (result.status !== "verified") {
      this.notice = "Location changed. Retarget this note.";
      this.open = true;
      this.panelOpen = true;
      this.render();
      return;
    }
    this.pendingLocation = null;
    this.notice = "";
    this.open = !collapse;
    this.panelOpen = !collapse;
    this.render();
    result.element.scrollIntoView({ behavior: "smooth", block: "center" });
    const originalTabIndex = result.element.getAttribute("tabindex");
    if (result.element.tabIndex < 0) result.element.setAttribute("tabindex", "-1");
    result.element.focus({ preventScroll: true });
    this.highlightedId = annotation.id;
    this.scheduleOverlayUpdate();
    window.setTimeout(() => {
      this.highlightedId = null;
      if (originalTabIndex === null) result.element.removeAttribute("tabindex");
      else result.element.setAttribute("tabindex", originalTabIndex);
      this.scheduleOverlayUpdate();
    }, 1800);
  }

  openLocation() {
    const url = new URL(this.pendingLocation, location.href);
    if (url.origin === location.origin && /^https?:$/.test(url.protocol)) location.assign(url.href);
  }

  async finish() {
    if (!this.data.session) return;
    const id = this.finishOperationId || crypto.randomUUID();
    this.finishOperationId = id;
    const revision = this.data.session.revision;
    this.save = "Saving";
    this.moreOpen = false;
    this.render();
    try {
      const result = await this.api.finish(revision, id);
      this.data.session = result.session;
      this.outbox.remove(id);
      this.finishOperationId = null;
      this.save = "Saved";
      this.tool = null;
      this.restorePause();
      this.panelOpen = true;
      this.render();
    } catch (error) {
      if (!navigator.onLine || error instanceof TypeError) {
        if (!this.outbox.all().some((item) => item.id === id)) this.outbox.add({ id, operation: { kind: "finish", revision }, createdAt: Date.now() });
        this.save = "Offline";
      }
      else {
        this.save = null;
        this.notice = error.message;
      }
      this.panelOpen = true;
      this.render();
    }
  }

  togglePause() {
    if (this.pausedActive) this.restorePause();
    else this.pause();
    this.render();
  }

  restorePause() {
    for (const item of this.paused) {
      item.animation.playbackRate = item.rate;
      if (item.wasPlaying) item.animation.play();
    }
    this.paused = [];
    this.pausedActive = false;
  }

  pause() {
    this.restorePause();
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (target?.getRootNode?.() === this.shadow || target === this.host) continue;
      this.paused.push({ animation, rate: animation.playbackRate, wasPlaying: animation.playState === "running" });
      animation.pause();
    }
    this.pausedActive = true;
  }
}
