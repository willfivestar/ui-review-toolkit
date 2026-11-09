export function reviewScope(sessionId, endpoint, location = window.location) {
  return `${new URL(endpoint || location.origin, location.origin).origin}:${sessionId}`;
}

export function consumeReviewCapability(sessionId, location = window.location, history = window.history, storage = window.sessionStorage, endpoint = location.origin) {
  const scope = reviewScope(sessionId, endpoint, location);
  const storageKey = `ui-review-next:capability:${scope}`;
  const fragment = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  const capability = fragment.get("review");
  if (!capability) return storage?.getItem(storageKey) || null;
  if (storage?.getItem(storageKey) !== capability) storage?.removeItem(`ui-review-next:outbox:${scope}`);
  storage?.setItem(storageKey, capability);
  fragment.delete("review");
  const tail = fragment.toString();
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}${tail ? `#${tail}` : ""}`,
  );
  return capability;
}

export function operationId() { return crypto.randomUUID(); }

export class ReviewApi {
  [key: string]: any;
  constructor({ sessionId, endpoint = window.location.origin, capability, passcode, fetchImpl = window.fetch.bind(window) }: any) {
    this.base = `${String(endpoint).replace(/\/$/, "")}/review-next/${encodeURIComponent(sessionId)}`;
    this.capability = capability;
    this.passcode = passcode;
    this.fetch = fetchImpl;
  }
  setPasscode(passcode) { this.passcode = passcode || undefined; }
  headers(idempotencyKey) {
    // Browsers own the Origin header. Trying to set it from JavaScript is forbidden
    // and can be silently discarded; the server validates the browser-supplied value.
    const headers = { Authorization: `Review ${this.capability}`, Accept: "application/json" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (this.passcode) headers["X-Review-Passcode"] = this.passcode;
    return headers;
  }
  async request(path, options: any = {}) {
    const response = await this.fetch(`${this.base}${path}`, { ...options, headers: { ...this.headers(options.idempotencyKey), ...(options.headers || {}) }, cache: "no-store", credentials: "omit", redirect: "error" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error: any = new Error(body.error || body.detail || `review request failed (${response.status})`); error.status = response.status; error.body = body; throw error; }
    return body;
  }
  load() { return this.request(""); }
  events(after) { return this.request(`/events?after=${encodeURIComponent(after || 0)}`); }
  create(annotation, baseRevision, idempotencyKey = operationId()) { return this.request("/annotations", { method: "POST", idempotencyKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...annotation, baseRevision }) }); }
  update(id, update, revision, baseRevision, idempotencyKey = operationId()) { return this.request(`/annotations/${encodeURIComponent(id)}`, { method: "PATCH", idempotencyKey, headers: { "Content-Type": "application/json", "If-Match": String(revision) }, body: JSON.stringify({ ...update, revision, baseRevision }) }); }
  finish(baseRevision, idempotencyKey = operationId()) { return this.request("/finish", { method: "POST", idempotencyKey, headers: { "Content-Type": "application/json", "If-Match": String(baseRevision) }, body: JSON.stringify({ baseRevision }) }); }
}
