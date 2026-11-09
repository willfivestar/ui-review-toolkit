"""Authenticated owner/agent control plane for route-isolated UI Review Next."""

import hashlib
import hmac
import json
import re
import uuid
from datetime import timedelta
from html import escape
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.db import get_session
from app.core.settings import get_settings
from app.models.review_next import (
    ReviewNextAccessGrant,
    ReviewNextAnnotation,
    ReviewNextEvent,
    ReviewNextSession,
)
from app.models.user import User
from app.review_next.security import (
    SESSION_ID_PATTERN,
    VALID_STATES,
    capability_hash,
    hash_passcode,
    now,
    origin_from_page_url,
    request_hash,
    require_idempotency,
    require_revision,
    sanitize_page_url,
)
from app.v1.auth import current_user

router = APIRouter(prefix="/review-next")
settings = get_settings()
STATIC_ROOT = Path(__file__).resolve().parents[2] / "static"
SECRET_HEADERS = {
    "Cache-Control": "private, no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
}


def _session_dict(item: ReviewNextSession) -> dict:
    return {
        "id": item.session_id,
        "mode": item.mode,
        "schemaVersion": item.schema_version,
        "title": item.title,
        "pageUrl": item.page_url,
        "status": item.status,
        "revision": item.revision,
        "assignedAgentId": str(item.assigned_agent_id) if item.assigned_agent_id else None,
        "expiresAt": item.expires_at.isoformat() if item.expires_at else None,
        "createdAt": item.created_at.isoformat(),
        "updatedAt": item.updated_at.isoformat(),
    }


def _annotation_dict(item: ReviewNextAnnotation, db: Session) -> dict:
    replies = (
        db.execute(
            select(ReviewNextEvent)
            .where(
                ReviewNextEvent.annotation_id == item.id,
                ReviewNextEvent.event_type == "reply",
            )
            .order_by(ReviewNextEvent.event_number)
        )
        .scalars()
        .all()
    )
    return {
        "id": item.annotation_id,
        "type": item.annotation_type,
        "state": item.state,
        "fixSummary": item.fix_summary,
        "revision": item.revision,
        "comment": item.comment,
        "target": item.target,
        "replies": [
            {
                "id": str(reply.id),
                "text": reply.payload.get("text", ""),
                "authorRole": reply.payload.get("authorRole", "builder"),
                "createdAt": reply.created_at.isoformat(),
            }
            for reply in replies
        ],
        "createdAt": item.created_at.isoformat(),
        "updatedAt": item.updated_at.isoformat(),
    }


def _asset_name() -> str:
    try:
        value = json.loads(
            (STATIC_ROOT / "ui-review-next.manifest.json").read_text("utf-8")
        )["asset"]
    except (OSError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Review Next asset unavailable") from exc
    if not isinstance(value, str) or not re.fullmatch(r"ui-review-next\.[a-f0-9]{16}\.js", value):
        raise HTTPException(status_code=503, detail="Review Next asset unavailable")
    return value


def _integration_response(
    session: ReviewNextSession,
    grant: ReviewNextAccessGrant,
    capability: str,
) -> dict:
    endpoint = settings.public_base_url_review
    asset_url = f"{endpoint}/review-next/assets/{_asset_name()}"
    parts = urlsplit(session.page_url)
    reviewer_url = urlunsplit((*parts[:4], f"review={capability}"))
    snippet = (
        "<script>window.UI_REVIEW_NEXT="
        + json.dumps(
            {"endpoint": endpoint, "sessionId": session.session_id, "version": "next"},
            separators=(",", ":"),
        ).replace("<", "\\u003c")
        + ";</script>\n"
        + f'<script src="{escape(asset_url, quote=True)}"></script>'
    )
    return {
        "id": session.session_id,
        "sessionId": session.session_id,
        "status": session.status,
        "endpoint": endpoint,
        "assetUrl": asset_url,
        "snippet": snippet,
        "reviewerUrl": reviewer_url,
        "session": _session_dict(session),
        "grant": {
            "id": str(grant.id),
            "origin": grant.allowed_origin,
            "expiresAt": grant.expires_at.isoformat() if grant.expires_at else None,
        },
        "capability": capability,
    }


def _secret_response(body: dict) -> JSONResponse:
    return JSONResponse(body, headers=SECRET_HEADERS)


def _owned(
    sid: str, user: User, db: Session, *, lock: bool = False, allow_agent: bool = False
) -> ReviewNextSession:
    principal = ReviewNextSession.owner_id == user.id
    if allow_agent:
        principal = or_(principal, ReviewNextSession.assigned_agent_id == user.id)
    query = select(ReviewNextSession).where(ReviewNextSession.session_id == sid, principal)
    if lock:
        query = query.with_for_update()
    item = db.execute(query).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="session not found")
    return item


def _record(
    db: Session,
    session: ReviewNextSession,
    *,
    actor_key: str,
    operation: str,
    event_type: str,
    payload: dict,
    response: dict,
    annotation: ReviewNextAnnotation | None = None,
    idempotency_key: str | None = None,
    body_hash: str | None = None,
) -> ReviewNextEvent:
    event = ReviewNextEvent(
        session_id=session.id,
        annotation_id=annotation.id if annotation else None,
        event_number=session.revision,
        actor_key=actor_key,
        operation=operation,
        event_type=event_type,
        idempotency_key=idempotency_key,
        request_hash=body_hash,
        payload=payload,
        response=response,
    )
    db.add(event)
    return event


def _replay(
    db: Session,
    session: ReviewNextSession,
    *,
    actor_key: str,
    operation: str,
    key: str,
    body_hash: str,
) -> dict | None:
    event = db.execute(
        select(ReviewNextEvent).where(
            ReviewNextEvent.session_id == session.id,
            ReviewNextEvent.actor_key == actor_key,
            ReviewNextEvent.operation == operation,
            ReviewNextEvent.idempotency_key == key,
        )
    ).scalar_one_or_none()
    if event is None:
        return None
    if event.request_hash != body_hash:
        raise HTTPException(status_code=409, detail={"error": "idempotency_conflict"})
    return dict(event.response or {})


def _conflict(session: ReviewNextSession) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={"error": "revision_conflict", "current": _session_dict(session)},
    )


def _new_grant(
    session: ReviewNextSession,
    body: dict,
    db: Session,
    *,
    raw_capability: str | None = None,
    grant_id: uuid.UUID | None = None,
) -> tuple[ReviewNextAccessGrant, str]:
    if raw_capability is None:
        raise RuntimeError("Review Next grants require a server-derived capability")
    raw = raw_capability
    try:
        origin = (
            origin_from_page_url(session.page_url)
            if body.get("origin") is None
            else str(body["origin"])
        )
        # normalize after accepting the default/explicit branch; importing here avoids
        # a permissive URL split or any implied sibling-origin match.
        from app.review_next.security import normalize_origin

        origin = normalize_origin(origin)
        passcode = body.get("passcode")
        passcode_hash = hash_passcode(passcode) if passcode is not None else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    expires_at = min(session.expires_at or now() + timedelta(days=30), now() + timedelta(days=30))
    if body.get("expiresAt") is not None:
        value = body["expiresAt"]
        if not isinstance(value, str):
            raise HTTPException(
                status_code=422, detail="expiresAt must be an ISO timestamp"
            )
        try:
            from datetime import datetime

            expires_at = datetime.fromisoformat(value)
        except ValueError as exc:
            raise HTTPException(
                status_code=422, detail="expiresAt must be an ISO timestamp"
            ) from exc
        if expires_at.tzinfo is None or expires_at <= now():
            raise HTTPException(
                status_code=422, detail="expiresAt must be in the future"
            )
        expires_at = min(expires_at, session.expires_at or expires_at, now() + timedelta(days=30))
    grant = ReviewNextAccessGrant(
        id=grant_id or uuid.uuid4(),
        session_id=session.id,
        capability_hash=capability_hash(raw),
        allowed_origin=origin,
        passcode_hash=passcode_hash,
        expires_at=expires_at,
    )
    db.add(grant)
    db.flush()
    return grant, raw


def _derived_capability(
    user: User,
    session: ReviewNextSession,
    operation: str,
    key: str,
    grant_id: uuid.UUID,
) -> str:
    """Replay an owner-issued capability without storing its raw bearer secret."""
    material = (
        f"review-next:{user.id}:{session.id}:{operation}:{key}:{grant_id}".encode()
    )
    return hmac.new(settings.grant_signing_key.get_secret_value().encode(), material, hashlib.sha256).hexdigest()


def _new_derived_grant(
    session: ReviewNextSession,
    body: dict,
    db: Session,
    *,
    user: User,
    operation: str,
    key: str,
) -> tuple[ReviewNextAccessGrant, str]:
    grant_id = uuid.uuid4()
    raw = _derived_capability(user, session, operation, key, grant_id)
    grant, _ignored = _new_grant(
        session, body, db, raw_capability=raw, grant_id=grant_id
    )
    return grant, raw


def _create_session(
    request: Request,
    body: dict,
    user: User,
    db: Session,
    *,
    require_query_mode: bool,
) -> object:
    key = require_idempotency(request)
    if (require_query_mode and request.query_params.get("mode") != "next") or body.get("mode") != "next":
        raise HTTPException(
            status_code=422, detail="UI Review Next creation requires mode=next"
        )
    # A deterministic, secret-derived default makes a dropped creation response safely
    # replayable without retaining a raw reviewer secret at rest.
    seed = f"review-session:create:{user.id}:{key}".encode()
    derived = hmac.new(
        settings.grant_signing_key.get_secret_value().encode(), seed, hashlib.sha256
    ).hexdigest()
    sid = body.get("id") or f"next_{derived[:36]}"
    if not isinstance(sid, str) or not SESSION_ID_PATTERN.fullmatch(sid):
        raise HTTPException(status_code=422, detail="id must be 1-80 URL-safe characters")
    existing = db.execute(
        select(ReviewNextSession).where(ReviewNextSession.session_id == sid)
    ).scalar_one_or_none()
    if existing is not None:
        event = db.execute(
            select(ReviewNextEvent).where(
                ReviewNextEvent.session_id == existing.id,
                ReviewNextEvent.actor_key == f"owner:{user.id}",
                ReviewNextEvent.operation == "create",
                ReviewNextEvent.idempotency_key == key,
            )
        ).scalar_one_or_none()
        if event is None or event.request_hash != request_hash(body):
            raise HTTPException(status_code=409, detail="session exists")
        grants = (
            db.execute(
                select(ReviewNextAccessGrant)
                .where(ReviewNextAccessGrant.session_id == existing.id)
                .order_by(ReviewNextAccessGrant.created_at)
            )
            .scalars()
            .all()
        )
        if not grants:
            raise HTTPException(status_code=409, detail="creation cannot be replayed")
        # Reconstruct only the deterministic first capability; no raw capability is
        # persisted in an event, grant, or idempotency response.
        grant = grants[0]
        raw = _derived_capability(user, existing, "create", key, grant.id)
        if capability_hash(raw) != grant.capability_hash:
            raise HTTPException(
                status_code=409, detail="creation capability cannot be replayed"
            )
        return _secret_response(_integration_response(existing, grant, raw))
    try:
        page_url = sanitize_page_url(body.get("pageUrl"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    title = body.get("title")
    if title is not None and (not isinstance(title, str) or len(title) > 300):
        raise HTTPException(
            status_code=422, detail="title must be at most 300 characters"
        )
    assigned_agent_id = body.get("assignedAgentId")
    if assigned_agent_id is not None:
        try:
            assigned_agent_id = uuid.UUID(str(assigned_agent_id))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="assignedAgentId must be a user UUID") from exc
        if db.get(User, assigned_agent_id) is None:
            raise HTTPException(status_code=422, detail="assigned agent not found")
    session = ReviewNextSession(
        owner_id=user.id,
        assigned_agent_id=assigned_agent_id,
        session_id=sid,
        title=title,
        page_url=page_url,
        status="open",
        revision=0,
    )
    db.add(session)
    db.flush()
    grant, raw = _new_derived_grant(
        session, body, db, user=user, operation="create", key=key
    )
    response = _integration_response(session, grant, raw)
    _record(
        db,
        session,
        actor_key=f"owner:{user.id}",
        operation="create",
        event_type="session_created",
        payload={},
        response={
            "session": _session_dict(session),
            "grant": {"id": str(grant.id), "origin": grant.allowed_origin},
        },
        idempotency_key=key,
        body_hash=request_hash(body),
    )
    db.commit()
    return _secret_response(response)


@router.post("")
def create_session(
    request: Request,
    body: dict = Body(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> object:
    return _create_session(request, body, user, db, require_query_mode=True)


@router.get("")
def list_sessions(
    user: User = Depends(current_user), db: Session = Depends(get_session)
) -> dict:
    rows = (
        db.execute(
            select(ReviewNextSession)
            .where(or_(ReviewNextSession.owner_id == user.id, ReviewNextSession.assigned_agent_id == user.id))
            .order_by(ReviewNextSession.created_at.desc())
        )
        .scalars()
        .all()
    )
    return {"sessions": [_session_dict(item) for item in rows]}


@router.get("/{sid}")
def get_next_session(
    sid: str, user: User = Depends(current_user), db: Session = Depends(get_session)
) -> dict:
    session = _owned(sid, user, db, allow_agent=True)
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


@router.post("/{sid}/grants")
def issue_grant(
    sid: str,
    request: Request,
    body: dict = Body(default={}),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    key = require_idempotency(request)
    session = _owned(sid, user, db, lock=True)
    body_hash = request_hash(body)
    replay = _replay(
        db,
        session,
        actor_key=f"owner:{user.id}",
        operation="issue_grant",
        key=key,
        body_hash=body_hash,
    )
    if replay is not None:
        grant = db.get(ReviewNextAccessGrant, uuid.UUID(replay["grant"]["id"]))
        if grant is None:
            raise HTTPException(status_code=409, detail="grant replay unavailable")
        raw = _derived_capability(user, session, "issue_grant", key, grant.id)
        return _secret_response(
            {
                **_integration_response(session, grant, raw),
                "sessionRevision": session.revision,
            }
        )
    if require_revision(request, body) != session.revision:
        return _conflict(session)
    if session.status not in {"open", "reopened"}:
        raise HTTPException(status_code=409, detail="session is not open")
    grant, raw = _new_derived_grant(
        session, body, db, user=user, operation="issue_grant", key=key
    )
    session.revision += 1
    response = {
        **_integration_response(session, grant, raw),
        "sessionRevision": session.revision,
    }
    _record(
        db,
        session,
        actor_key=f"owner:{user.id}",
        operation="issue_grant",
        event_type="grant_issued",
        payload={"grantId": str(grant.id)},
        response={
            "sessionRevision": session.revision,
            "grant": {
                "id": str(grant.id),
                "origin": grant.allowed_origin,
                "expiresAt": grant.expires_at.isoformat() if grant.expires_at else None,
            },
        },
        idempotency_key=key,
        body_hash=body_hash,
    )
    db.commit()
    return _secret_response(response)


@router.delete("/{sid}/grants/{grant_id}")
def revoke_grant(
    sid: str,
    grant_id: uuid.UUID,
    request: Request,
    body: dict = Body(default={}),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    key = require_idempotency(request)
    session = _owned(sid, user, db, lock=True)
    hashed = request_hash(body)
    replay = _replay(
        db,
        session,
        actor_key=f"owner:{user.id}",
        operation="revoke_grant",
        key=key,
        body_hash=hashed,
    )
    if replay is not None:
        return replay
    if require_revision(request, body) != session.revision:
        return _conflict(session)
    grant = db.execute(
        select(ReviewNextAccessGrant).where(
            ReviewNextAccessGrant.id == grant_id,
            ReviewNextAccessGrant.session_id == session.id,
        )
    ).scalar_one_or_none()
    if grant is None:
        raise HTTPException(status_code=404, detail="grant not found")
    grant.revoked_at = now()
    session.revision += 1
    response = {"ok": True, "sessionRevision": session.revision}
    _record(
        db,
        session,
        actor_key=f"owner:{user.id}",
        operation="revoke_grant",
        event_type="grant_revoked",
        payload={"grantId": str(grant.id)},
        response=response,
        idempotency_key=key,
        body_hash=hashed,
    )
    db.commit()
    return response


def _owner_annotation_change(
    sid: str,
    annotation_id: str,
    request: Request,
    body: dict,
    user: User,
    db: Session,
    *,
    reply: bool,
) -> dict:
    key = require_idempotency(request)
    session = _owned(sid, user, db, lock=True, allow_agent=True)
    principal = "owner" if session.owner_id == user.id else "agent"
    actor = f"{principal}:{user.id}"
    operation = "reply" if reply else "state"
    hashed = request_hash(body)
    replay = _replay(
        db, session, actor_key=actor, operation=operation, key=key, body_hash=hashed
    )
    if replay is not None:
        return replay
    annotation = db.execute(
        select(ReviewNextAnnotation)
        .where(
            ReviewNextAnnotation.session_id == session.id,
            ReviewNextAnnotation.annotation_id == annotation_id,
        )
        .with_for_update()
    ).scalar_one_or_none()
    if annotation is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    required = require_revision(request, body)
    if required != session.revision:
        return _conflict(session)
    if reply:
        text = body.get("text")
        if not isinstance(text, str) or not text or len(text) > 8_000:
            raise HTTPException(
                status_code=422, detail="text must be 1-8000 characters"
            )
        payload, event_type = {"text": text, "authorRole": principal}, "reply"
    else:
        state = body.get("state")
        if not isinstance(state, str) or state not in VALID_STATES:
            raise HTTPException(status_code=422, detail="invalid annotation state")
        fix_summary = body.get("fixSummary")
        if fix_summary is not None and (
            not isinstance(fix_summary, str) or len(fix_summary) > 8_000
        ):
            raise HTTPException(
                status_code=422, detail="fixSummary must be at most 8000 characters"
            )
        if state in {"fixed", "dismissed"} and not (fix_summary or "").strip():
            raise HTTPException(
                status_code=422, detail="fixSummary is required for fixed or dismissed"
            )
        annotation.state = state
        annotation.fix_summary = fix_summary
        annotation.revision += 1
        payload, event_type = {
            "state": state,
            "fixSummary": fix_summary,
        }, "state_changed"
    session.revision += 1
    event = _record(
        db,
        session,
        actor_key=actor,
        operation=operation,
        event_type=event_type,
        payload=payload,
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


@router.post("/{sid}/annotations/{annotation_id}/replies")
def owner_reply(
    sid: str,
    annotation_id: str,
    request: Request,
    body: dict = Body(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    return _owner_annotation_change(
        sid, annotation_id, request, body, user, db, reply=True
    )


@router.post("/{sid}/annotations/{annotation_id}/state")
def owner_state(
    sid: str,
    annotation_id: str,
    request: Request,
    body: dict = Body(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    return _owner_annotation_change(
        sid, annotation_id, request, body, user, db, reply=False
    )


@router.post("/{sid}/finish")
def owner_finish(
    sid: str,
    request: Request,
    body: dict = Body(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    return _owner_lifecycle(sid, request, body, user, db, "finish")


@router.post("/{sid}/reopen")
def owner_reopen(
    sid: str,
    request: Request,
    body: dict = Body(default={}),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    return _owner_lifecycle(sid, request, body, user, db, "reopen")


@router.post("/{sid}/archive")
def owner_archive(
    sid: str,
    request: Request,
    body: dict = Body(default={}),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    return _owner_lifecycle(sid, request, body, user, db, "archive")


@router.post("/{sid}/expire")
def owner_expire(
    sid: str,
    request: Request,
    body: dict = Body(default={}),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    return _owner_lifecycle(sid, request, body, user, db, "expire")


def _owner_lifecycle(
    sid: str, request: Request, body: dict, user: User, db: Session, action: str
) -> object:
    key = require_idempotency(request)
    session = _owned(sid, user, db, lock=True)
    actor = f"owner:{user.id}"
    hashed = request_hash(body)
    replay = _replay(
        db, session, actor_key=actor, operation=action, key=key, body_hash=hashed
    )
    if replay is not None:
        if action == "reopen":
            grant = db.get(ReviewNextAccessGrant, uuid.UUID(replay["grant"]["id"]))
            if grant is None:
                raise HTTPException(status_code=409, detail="grant replay unavailable")
            raw = _derived_capability(user, session, "reopen", key, grant.id)
            return _secret_response(_integration_response(session, grant, raw))
        return replay
    required = require_revision(request, body)
    if required != session.revision:
        return _conflict(session)
    extra: dict = {}
    reopened_grant: ReviewNextAccessGrant | None = None
    reopened_raw: str | None = None
    if action == "finish":
        if session.status not in {"open", "reopened"}:
            raise HTTPException(status_code=409, detail="session cannot be finished")
        session.status, session.finished_at, session.expires_at = (
            "finished",
            now(),
            now() + timedelta(days=30),
        )
    elif action == "archive":
        session.status = "archived"
    elif action == "expire":
        session.expires_at = now()
        for grant in db.execute(
            select(ReviewNextAccessGrant).where(
                ReviewNextAccessGrant.session_id == session.id,
                ReviewNextAccessGrant.revoked_at.is_(None),
            )
        ).scalars():
            grant.revoked_at = now()
    else:
        if session.status != "finished":
            raise HTTPException(
                status_code=409, detail="only finished sessions can reopen"
            )
        # Old grants cannot silently become valid after lifecycle re-open.
        for grant in db.execute(
            select(ReviewNextAccessGrant).where(
                ReviewNextAccessGrant.session_id == session.id,
                ReviewNextAccessGrant.revoked_at.is_(None),
            )
        ).scalars():
            grant.revoked_at = now()
        session.status, session.expires_at = "reopened", None
        reopened_grant, reopened_raw = _new_derived_grant(
            session, body, db, user=user, operation="reopen", key=key
        )
        extra = {
            "grant": {
                "id": str(reopened_grant.id),
                "origin": reopened_grant.allowed_origin,
            },
        }
    session.revision += 1
    response = {"session": _session_dict(session), **extra}
    event_type = {
        "finish": "session_finished",
        "reopen": "session_reopened",
        "archive": "session_archived",
        "expire": "session_expired",
    }[action]
    _record(
        db,
        session,
        actor_key=actor,
        operation=action,
        event_type=event_type,
        payload={
            "builderNotification": (
                "requested"
                if action == "finish"
                and settings.ui_review_finish_notification_mode == "event"
                else "disabled"
                if action == "finish"
                else None
            )
        },
        response=response,
        idempotency_key=key,
        body_hash=hashed,
    )
    db.commit()
    if reopened_grant is not None and reopened_raw is not None:
        return _secret_response(
            _integration_response(session, reopened_grant, reopened_raw)
        )
    return response


@router.get("/{sid}/history")
def history(
    sid: str, user: User = Depends(current_user), db: Session = Depends(get_session)
) -> dict:
    session = _owned(sid, user, db, allow_agent=True)
    events = (
        db.execute(
            select(ReviewNextEvent)
            .where(ReviewNextEvent.session_id == session.id)
            .order_by(ReviewNextEvent.event_number)
        )
        .scalars()
        .all()
    )
    return {
        "events": [
            {
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
            for item in events
        ]
    }


@router.get("/{sid}/events")
def owner_events(
    sid: str,
    after: int = 0,
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    if after < 0:
        raise HTTPException(status_code=422, detail="after must be non-negative")
    session = _owned(sid, user, db, allow_agent=True)
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
    values = [
        {
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
        for item in rows
    ]
    return {
        "events": values,
        "nextSequence": values[-1]["sequence"] if values else after,
    }
