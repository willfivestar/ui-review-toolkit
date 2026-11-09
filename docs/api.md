# HTTP API

Owner requests use `Authorization: Bearer <api-token>` under `/v1/review-next`. Use a trusted terminal or agent. The browser uses `Authorization: Review <capability>` only under `/review-next/<session-id>`; that credential is scoped to an active grant and exact preview origin.

## Create and install a review

`POST /v1/review-next?mode=next` with a unique `Idempotency-Key` header and JSON:

```json
{"mode":"next","pageUrl":"https://preview.example.com/","title":"Design review"}
```

Optional fields: a custom URL-safe `id`, `assignedAgentId` (an existing local user UUID), `passcode`, `expiresAt` (a future timezone-aware ISO timestamp; the grant is capped at 30 days), or an explicit `origin` for a trusted alternate preview origin. The response includes `sessionId`, `snippet`, `reviewerUrl`, and `grant.id`. Keep the response private; only the snippet belongs in page source. A safe retry uses the same body and key.

## Read feedback and make changes

Paths below are relative to `/v1/review-next`.

| Method and path | Result or body |
| --- | --- |
| `GET /` (use the base path without a trailing slash) | List sessions accessible to the current identity |
| `GET /{id}` | Session revision, annotations, replies and current states |
| `GET /{id}/events?after=0` | Events after a cursor; save `nextSequence` for the next request |
| `GET /{id}/history` | Owner-visible event history |
| `POST /{id}/annotations/{note}/replies` | `baseRevision`, `text` |
| `POST /{id}/annotations/{note}/state` | `baseRevision`, `state`, and `fixSummary` for `fixed` or `dismissed` |
| `POST /{id}/grants` | `baseRevision` with optional origin, passcode and expiry; returns a new secret reviewer link |
| `DELETE /{id}/grants/{grantId}` | `baseRevision`; revokes this grant |
| `POST /{id}/finish`, `/reopen`, `/archive`, `/expire` | `baseRevision`; reopen revokes existing grants and returns a fresh link |

Each mutation needs its own stable `Idempotency-Key` (reuse only to retry the identical request). Send the current session revision as `baseRevision`. On HTTP 409, read the current session and reconcile before attempting a new write. The assigned agent can read its assigned sessions, reply, and update note state. Owners control grants and lifecycle changes. Finish emits a `session_finished` event; consumers can use it to trigger their own workflow.
