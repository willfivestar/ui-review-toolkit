"""Capability-only reviewer surface.  It deliberately has no owner fallback."""

import json
import re
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_session
from app.core.settings import get_settings
from app.models.review_next import (
    ReviewNextAccessGrant,
    ReviewNextAnnotation,
    ReviewNextEvent,
    ReviewNextSession,
)
from app.review_next.security import (
    MAX_COMMENT,
    PEER_RATE_LIMIT,
    SESSION_ID_PATTERN,
    VALID_TYPES,
    capability_hash,
    enforce_reviewer_rate,
    normalize_origin,
    now,
    passcode_matches,
    request_hash,
    require_idempotency,
    require_revision,
    review_unavailable,
    sanitize_target,
    validate_target,
)
from app.v1.review_next import (
    _annotation_dict,
    _conflict,
    _record,
    _replay,
    _session_dict,
)

router = APIRouter(prefix="/review-next")
STATIC_ROOT = Path(__file__).resolve().parents[2] / "static"
settings = get_settings()


@router.get("/assets/{asset_name}")
def immutable_client_asset(asset_name: str) -> Response:
    """Serve only content-hashed clients retained by the committed manifest."""
    try:
        manifest = json.loads(
            (STATIC_ROOT / "ui-review-next.manifest.json").read_text("utf-8")
        )
    except (OSError, ValueError):
        raise HTTPException(status_code=404, detail="asset unavailable") from None
    retained = manifest.get("assets")
    allowed = {manifest.get("asset")}
    if isinstance(retained, list):
        allowed.update(
            item.get("asset")
            for item in retained
            if isinstance(item, dict) and isinstance(item.get("asset"), str)
        )
    if asset_name not in allowed or not re.fullmatch(r"ui-review-next\.[a-f0-9]{16}\.js", asset_name):
        raise HTTPException(status_code=404, detail="asset unavailable")
    path = STATIC_ROOT / asset_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="asset unavailable")
    return Response(
        path.read_bytes(),
        media_type="application/javascript",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _reviewer(
    sid: str, request: Request, db: Session, *, write: bool = False, lock: bool = False
) -> tuple[ReviewNextSession, ReviewNextAccessGrant]:
    if not SESSION_ID_PATTERN.fullmatch(sid):
        raise review_unavailable()
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Review ") or len(auth) <= 7:
        raise review_unavailable()
    origin = request.headers.get("Origin")
    if origin is None and request.headers.get("Sec-Fetch-Site") == "same-origin":
        # Browsers can omit Origin on same-origin GETs. Use the configured
        # origin, never an untrusted Host or forwarding header.
        origin = settings.public_base_url_review
    try:
        normalized_origin = normalize_origin(origin)
    except ValueError:
        raise review_unavailable() from None
    peer = request.client.host if request.client else "unknown"
    enforce_reviewer_rate(f"peer:{peer}", PEER_RATE_LIMIT)
    if not re.fullmatch(r"[a-f0-9]{64}", auth[7:]):
        raise review_unavailable()
    query = select(ReviewNextSession).where(ReviewNextSession.session_id == sid)
    session = db.execute(query).scalar_one_or_none()
    if session is None or session.status not in {"open", "finished", "reopened"}:
        raise review_unavailable()
    current = now()
    if session.expires_at is not None and session.expires_at <= current:
        raise review_unavailable()
    grant = db.execute(
        select(ReviewNextAccessGrant).where(
            ReviewNextAccessGrant.session_id == session.id,
            ReviewNextAccessGrant.capability_hash == capability_hash(auth[7:]),
            ReviewNextAccessGrant.allowed_origin == normalized_origin,
        )
    ).scalar_one_or_none()
    if (
        grant is None
        or grant.revoked_at is not None
        or (grant.expires_at is not None and grant.expires_at <= current)
    ):
        raise review_unavailable()
    # Once the active capability and its exact origin are proven, expose only the
    # opaque auth failure status so a browser can render the optional passcode form.
    # Wrong capabilities and origins remain indistinguishable and receive no ACAO.
    request.state.review_next_origin = normalized_origin
    enforce_reviewer_rate(f"grant:{grant.id}")
    if not passcode_matches(
        request.headers.get("X-Review-Passcode"), grant.passcode_hash
    ):
        raise review_unavailable()
    if lock:
        # Only an authenticated reviewer can acquire the write lock. Refresh
        # after acquiring it in case the owner revoked access in the meantime.
        session = db.scalar(query.with_for_update().execution_options(populate_existing=True))
        db.refresh(grant)
        current = now()
        if (
            session is None
            or session.status not in {"open", "finished", "reopened"}
            or (session.expires_at and session.expires_at <= current)
            or grant.revoked_at
            or (grant.expires_at and grant.expires_at <= current)
        ):
            raise review_unavailable()
    if write and session.status not in {"open", "reopened"}:
        raise review_unavailable()
    return session, grant


def _body_object(body: object) -> dict:
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="body must be an object")
    return body


def _public_response(session: ReviewNextSession, db: Session) -> dict:
    annotations = (
        db.execute(
            select(ReviewNextAnnotation)
            .where(ReviewNextAnnotation.session_id == session.id)
            .order_by(ReviewNextAnnotation.created_at)
        )
        .scalars()
        .all()
    )
    return {
        "session": _session_dict(session),
        "annotations": [_annotation_dict(item, db) for item in annotations],
    }


@router.get("/{sid}")
def bootstrap(sid: str, request: Request, db: Session = Depends(get_session)) -> dict:
    session, _grant = _reviewer(sid, request, db)
    return _public_response(session, db)


@router.get("/{sid}/annotations")
def annotations(sid: str, request: Request, db: Session = Depends(get_session)) -> dict:
    session, _grant = _reviewer(sid, request, db)
    return _public_response(session, db)


@router.post("/{sid}/annotations")
def create_annotation(
    sid: str,
    request: Request,
    body: dict = Body(...),
    db: Session = Depends(get_session),
) -> dict:
    body = _body_object(body)
    key = require_idempotency(request)
    session, grant = _reviewer(sid, request, db, lock=True)
    actor = f"grant:{grant.id}"
    hashed = request_hash(body)
    replay = _replay(
        db,
        session,
        actor_key=actor,
        operation="create_annotation",
        key=key,
        body_hash=hashed,
    )
    if replay is not None:
        return replay
    if session.status not in {"open", "reopened"}:
        raise review_unavailable()
    if require_revision(request, body) != session.revision:
        return _conflict(session)
    annotation_type = body.get("type")
    comment = body.get("comment")
    if not isinstance(annotation_type, str) or annotation_type not in VALID_TYPES:
        raise HTTPException(status_code=422, detail="invalid annotation type")
    if (
        not isinstance(comment, str)
        or not comment.strip()
        or len(comment) > MAX_COMMENT
    ):
        raise HTTPException(status_code=422, detail="comment must be 1-8000 characters")
    try:
        target = validate_target(annotation_type, sanitize_target(body.get("target")))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    annotation_id = body.get("id") or f"ann_{key[:64]}"
    if not isinstance(annotation_id, str) or not 1 <= len(annotation_id) <= 80:
        raise HTTPException(
            status_code=422, detail="annotation id must be 1-80 characters"
        )
    if db.execute(
        select(ReviewNextAnnotation).where(
            ReviewNextAnnotation.session_id == session.id,
            ReviewNextAnnotation.annotation_id == annotation_id,
        )
    ).scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="annotation id exists")
    annotation = ReviewNextAnnotation(
        session_id=session.id,
        annotation_id=annotation_id,
        annotation_type=annotation_type,
        comment=comment,
        target=target,
        state="open",
        revision=1,
    )
    db.add(annotation)
    db.flush()
    session.revision += 1
    response = {
        "sessionRevision": session.revision,
        "annotation": _annotation_dict(annotation, db),
    }
    _record(
        db,
        session,
        actor_key=actor,
        operation="create_annotation",
        event_type="annotation_created",
        payload={"annotationId": annotation_id},
        response=response,
        annotation=annotation,
        idempotency_key=key,
        body_hash=hashed,
    )
    db.commit()
    return response


@router.patch("/{sid}/annotations/{annotation_id}")
def update_annotation(
    sid: str,
    annotation_id: str,
    request: Request,
    body: dict = Body(...),
    db: Session = Depends(get_session),
) -> dict:
    body = _body_object(body)
    key = require_idempotency(request)
    session, grant = _reviewer(sid, request, db, lock=True)
    actor = f"grant:{grant.id}"
    hashed = request_hash(body)
    replay = _replay(
        db,
        session,
        actor_key=actor,
        operation="update_annotation",
        key=key,
        body_hash=hashed,
    )
    if replay is not None:
        return replay
    if session.status not in {"open", "reopened"}:
        raise review_unavailable()
    base_revision = body.get("baseRevision")
    if (
        isinstance(base_revision, bool)
        or not isinstance(base_revision, int)
        or base_revision < 0
    ):
        raise HTTPException(
            status_code=428, detail="current session baseRevision is required"
        )
    if base_revision != session.revision:
        return _conflict(session)
    annotation = db.execute(
        select(ReviewNextAnnotation)
        .where(
            ReviewNextAnnotation.session_id == session.id,
            ReviewNextAnnotation.annotation_id == annotation_id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if annotation is None:
        raise review_unavailable()
    annotation_revision = require_revision(request, body, key="revision")
    if annotation_revision != annotation.revision:
        return JSONResponse(
            status_code=409,
            content={
                "error": "revision_conflict",
                "current": _annotation_dict(annotation, db),
                "sessionRevision": session.revision,
            },
        )
    changed = False
    if "comment" in body:
        comment = body["comment"]
        if (
            not isinstance(comment, str)
            or not comment.strip()
            or len(comment) > MAX_COMMENT
        ):
            raise HTTPException(
                status_code=422, detail="comment must be 1-8000 characters"
            )
        annotation.comment, changed = comment, True
    if "target" in body:
        try:
            annotation.target = validate_target(
                annotation.annotation_type, sanitize_target(body["target"])
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        changed = True
    if not changed:
        raise HTTPException(status_code=422, detail="comment or target is required")
    annotation.revision += 1
    session.revision += 1
    event = _record(
        db,
        session,
        actor_key=actor,
        operation="update_annotation",
        event_type="annotation_updated",
        payload={"annotationId": annotation_id},
        response={},
        annotation=annotation,
        idempotency_key=key,
        body_hash=hashed,
    )
    db.flush()
    response = {
        "sessionRevision": session.revision,
        "annotation": _annotation_dict(annotation, db),
    }
    event.response = response
    db.commit()
    return response


@router.post("/{sid}/finish")
def finish(
    sid: str,
    request: Request,
    body: dict = Body(...),
    db: Session = Depends(get_session),
) -> dict:
    body = _body_object(body)
    key = require_idempotency(request)
    session, grant = _reviewer(sid, request, db, lock=True)
    actor, hashed = f"grant:{grant.id}", request_hash(body)
    replay = _replay(
        db, session, actor_key=actor, operation="finish", key=key, body_hash=hashed
    )
    if replay is not None:
        return replay
    if session.status not in {"open", "reopened"}:
        raise review_unavailable()
    if require_revision(request, body) != session.revision:
        return _conflict(session)
    session.status, session.finished_at, session.expires_at = (
        "finished",
        now(),
        now() + timedelta(days=30),
    )
    session.revision += 1
    response = {"session": _session_dict(session)}
    _record(
        db,
        session,
        actor_key=actor,
        operation="finish",
        event_type="session_finished",
        payload={
            "builderNotification": (
                "requested"
                if settings.ui_review_finish_notification_mode == "event"
                else "disabled"
            )
        },
        response=response,
        idempotency_key=key,
        body_hash=hashed,
    )
    db.commit()
    return response


@router.get("/{sid}/events")
@router.get("/{sid}/watch")
def events(
    sid: str, request: Request, after: int = 0, db: Session = Depends(get_session)
) -> dict:
    if after < 0:
        raise HTTPException(status_code=422, detail="after must be non-negative")
    session, _grant = _reviewer(sid, request, db)
    rows = (
        db.execute(
            select(ReviewNextEvent)
            .where(
                ReviewNextEvent.session_id == session.id,
                ReviewNextEvent.event_number > after,
            )
            .order_by(ReviewNextEvent.event_number)
            .limit(100)
        )
        .scalars()
        .all()
    )
    values = []
    for item in rows:
        value = {
            "sequence": item.event_number,
            "type": item.event_type,
            "annotationId": (
                db.get(ReviewNextAnnotation, item.annotation_id).annotation_id
                if item.annotation_id
                and db.get(ReviewNextAnnotation, item.annotation_id) is not None
                else None
            ),
            "payload": item.payload,
            "createdAt": item.created_at.isoformat(),
        }
        if item.annotation_id is not None:
            annotation = db.get(ReviewNextAnnotation, item.annotation_id)
            if annotation is not None:
                value["annotation"] = _annotation_dict(annotation, db)
        else:
            value["session"] = _session_dict(session)
        values.append(value)
    return {
        "events": values,
        "nextSequence": values[-1]["sequence"] if values else after,
    }
