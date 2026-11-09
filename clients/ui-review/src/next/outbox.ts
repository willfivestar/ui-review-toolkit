export class Outbox {
  [key: string]: any;
  constructor(key, storage = sessionStorage) { this.key = `ui-review-next:outbox:${key}`; this.storage = storage; }
  all() { try { return JSON.parse(this.storage.getItem(this.key) || "[]"); } catch { return []; } }
  save(items) { this.storage.setItem(this.key, JSON.stringify(items)); }
  add(operation) { const items = this.all(); items.push(operation); this.save(items); }
  remove(id) { this.save(this.all().filter((item) => item.id !== id)); }
}
