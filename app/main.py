"""Standalone UI Review service."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text
from starlette.responses import JSONResponse

from app.core.db import engine
from app.models.base import Base
from app.review_next.cors import ReviewCorsMiddleware
from app.review_next.public import router as reviewer_router
from app.v1.review_next import router as owner_router

MAX_BODY = 64 * 1024


class RequestBoundary:
    """Bound JSON before decoding and protect credentialed responses from caches."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        is_asset = scope["path"].startswith("/review-next/assets/")

        async def send_safe(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                if not is_asset or message["status"] >= 400:
                    if not any(key == b"cache-control" for key, _ in headers):
                        headers.append((b"cache-control", b"private, no-store, max-age=0"))
                    if not any(key == b"referrer-policy" for key, _ in headers):
                        headers.append((b"referrer-policy", b"no-referrer"))
                if not any(key == b"x-content-type-options" for key, _ in headers):
                    headers.append((b"x-content-type-options", b"nosniff"))
            await send(message)

        if scope["method"] in {"POST", "PATCH", "PUT", "DELETE"}:
            chunks = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                data = message.get("body", b"")
                if len(chunks) + len(data) > MAX_BODY:
                    response = JSONResponse({"detail": "request too large"}, status_code=413)
                    await response(scope, receive, send_safe)
                    return
                chunks.extend(data)
                if not message.get("more_body"):
                    break
            original_receive = receive
            body = bytes(chunks)

            async def replay():
                nonlocal body
                if body is None:
                    return await original_receive()
                data, body = body, None
                return {"type": "http.request", "body": data, "more_body": False}

            receive = replay
        await self.app(scope, receive, send_safe)


@asynccontextmanager
async def lifespan(_app):
    with engine.begin() as connection:
        # Serialize first-run table creation when several workers boot together.
        connection.execute(text("SELECT pg_advisory_xact_lock(274605071)"))
        Base.metadata.create_all(connection)
    yield
    engine.dispose()


app = FastAPI(title="UI Review Toolkit", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(owner_router, prefix="/v1")
app.include_router(reviewer_router)
app.add_middleware(ReviewCorsMiddleware)
app.add_middleware(RequestBoundary)


@app.get("/health")
def health():
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"status": "ok"}
