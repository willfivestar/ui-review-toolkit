import { consumeReviewCapability } from "./api.ts";
import { ReviewClientImplementation } from "./review-client.ts";

export const ReviewClient = ReviewClientImplementation;

export function mount(options: any = {}) {
  if (!options.sessionId) throw new Error("UI Review requires a sessionId");
  const capability = options.capability || consumeReviewCapability(options.sessionId, window.location, window.history, window.sessionStorage, options.endpoint);
  if (!capability) return null; // Normal visits to the preview do not mount the reviewer UI.
  const client = new ReviewClient({ ...options, capability });
  client.start();
  return client;
}
