"""Origin policy for the reviewer routes; no owner cross-origin access."""

from datetime import UTC, datetime

from starlette.concurrency import run_in_threadpool
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.db import SessionLocal
from app.models.review_next import ReviewNextAccessGrant, ReviewNextSession
from app.review_next.security import SESSION_ID_PATTERN, normalize_origin


class ReviewCorsMiddleware:
    """Permit browser access only from the preview origin recorded on an active grant."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    @staticmethod
    def _is_next(scope: Scope) -> bool:
        return scope.get("path", "").startswith("/review-next/")

    @staticmethod
    def _preflight_allowed(scope: Scope) -> str | None:
        origin = scope.get("headers", [])
        headers = {
            key.decode("latin1").lower(): value.decode("latin1")
            for key, value in origin
        }
        try:
            normalized = normalize_origin(headers.get("origin"))
        except ValueError:
            return None
        pieces = scope.get("path", "").split("/")
        if len(pieces) < 3 or not SESSION_ID_PATTERN.fullmatch(pieces[2]):
            return None
        with SessionLocal() as db:
            session = (
                db.query(ReviewNextSession)
                .filter(ReviewNextSession.session_id == pieces[2])
                .one_or_none()
            )
            if session is None:
                return None
            current = datetime.now(UTC)
            if (
                session.status not in {"open", "finished", "reopened"}
                or session.expires_at is not None
                and session.expires_at <= current
            ):
                return None
            grant = (
                db.query(ReviewNextAccessGrant)
                .filter(
                    ReviewNextAccessGrant.session_id == session.id,
                    ReviewNextAccessGrant.allowed_origin == normalized,
                    ReviewNextAccessGrant.revoked_at.is_(None),
                )
                .all()
            )
            if any(
                item.expires_at is None or item.expires_at > current for item in grant
            ):
                return normalized
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        next_route = self._is_next(scope)
        if next_route and scope["method"] == "OPTIONS":
            allowed = await run_in_threadpool(self._preflight_allowed, scope)
            headers = {
                "Vary": "Origin",
                "Cache-Control": "private, no-store, max-age=0",
                "Referrer-Policy": "no-referrer",
            }
            # OPTIONS cannot carry an Authorization credential.  Keep failures status/body
            # indistinguishable (rather than turning this into a session oracle), while a
            # matching trusted origin receives the transport permission needed to make its
            # subsequent capability-authenticated request.
            if allowed:
                headers.update(
                    {
                        "Access-Control-Allow-Origin": allowed,
                        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
                        "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, If-Match, X-Review-Passcode",
                        "Access-Control-Max-Age": "600",
                    }
                )
            response = Response(status_code=204, headers=headers)
            await response(scope, receive, send)
            return

        async def send_wrapped(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                if next_route:
                    # Authorization set this only after an active grant has matched both
                    # the exact request Origin and reviewer capability.
                    approved = scope.get("state", {}).get("review_next_origin")
                    headers = [
                        (key, value)
                        for key, value in headers
                        if not key.lower().startswith(b"access-control-")
                    ]
                    if approved:
                        headers.extend(
                            [
                                (
                                    b"access-control-allow-origin",
                                    approved.encode("latin1"),
                                ),
                                (b"vary", b"Origin"),
                            ]
                        )
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapped)
