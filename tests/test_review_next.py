"""Contract tests for the additive, capability-only UI Review Next routes."""

import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.db import session_scope
from app.main import app
from app.models.review_next import (
    ReviewNextAccessGrant,
    ReviewNextEvent,
    ReviewNextSession,
)
from app.models.user import ApiToken, User
from app.review_next import public as review_public
from app.review_next.security import (
    REVIEW_RATE_LIMIT,
    _review_attempts,
    sanitize_page_url,
    validate_target,
)
from app.v1.auth import generate_token, hash_token

client = TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def lifespan():
    with client:
        yield
ORIGIN = "https://preview-review-next.example.test"


@pytest.fixture(scope="module")
def owner_token() -> str:
    raw = generate_token()
    with session_scope() as db:
        email = f"review-next-{uuid.uuid4().hex}@example.test"
        user = User(email=email, name="review next", role="user")
        db.add(user)
        db.flush()
        db.add(
            ApiToken(
                user_id=user.id, token_hash=hash_token(raw), label="review-next-test"
            )
        )
        db.commit()
    return raw


@pytest.fixture(scope="module")
def agent_identity() -> tuple[str, str]:
    raw = generate_token()
    with session_scope() as db:
        user = User(
            email=f"review-next-agent-{uuid.uuid4().hex}@example.test",
            name="review next agent",
            role="user",
        )
        db.add(user)
        db.flush()
        identity = str(user.id)
        db.add(ApiToken(user_id=user.id, token_hash=hash_token(raw), label="agent"))
        db.commit()
    return raw, identity


def _owner(token: str, key: str | None = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    if key:
        headers["Idempotency-Key"] = key
    return headers


def _create(token: str, key: str = "create-review-next-0123456789") -> dict:
    response = client.post(
        "/v1/review-next?mode=next",
        headers=_owner(token, key),
        json={
            "mode": "next",
            "id": f"next-test-{uuid.uuid4().hex[:16]}",
            "title": "Review",
            "pageUrl": f"{ORIGIN}/a?secret=no#fragment",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _reviewer(capability: str, *, origin: str = ORIGIN, key: str | None = None) -> dict:
    headers = {"Authorization": f"Review {capability}", "Origin": origin}
    if key:
        headers["Idempotency-Key"] = key
    return headers


def test_next_mode_required_and_create_replay_is_hash_only(owner_token: str):
    wrong = client.post(
        "/v1/review-next",
        headers=_owner(owner_token, "wrong-next-mode-012345678"),
        json={"pageUrl": f"{ORIGIN}/"},
    )
    assert wrong.status_code == 422
    key = "create-replay-012345678901234567890"
    session_id = f"next-replay-{uuid.uuid4().hex[:12]}"
    request = {
        "mode": "next",
        "id": session_id,
        "pageUrl": f"{ORIGIN}/path?view=grid&token=gone&api_key=gone",
    }
    first = client.post(
        "/v1/review-next?mode=next", headers=_owner(owner_token, key), json=request
    )
    second = client.post(
        "/v1/review-next?mode=next", headers=_owner(owner_token, key), json=request
    )
    assert first.status_code == second.status_code == 200
    assert second.json()["capability"] == first.json()["capability"]
    assert first.json()["session"]["pageUrl"] == f"{ORIGIN}/path?view=grid"
    assert first.headers["cache-control"] == "private, no-store, max-age=0"
    assert first.headers["referrer-policy"] == "no-referrer"
    assert "#review=" in first.json()["reviewerUrl"]
    assert first.json()["capability"] not in first.json()["snippet"]
    assert first.json()["assetUrl"].endswith(".js")
    with session_scope() as db:
        session = (
            db.query(ReviewNextSession).filter_by(session_id=session_id).one()
        )
        grant = db.query(ReviewNextAccessGrant).filter_by(session_id=session.id).one()
        event = (
            db.query(ReviewNextEvent)
            .filter_by(session_id=session.id, operation="create")
            .one()
        )
        raw = first.json()["capability"]
        assert raw not in grant.capability_hash
        assert raw not in str(event.payload)
        assert raw not in str(event.response)


def test_reviewer_security_cors_lifecycle_and_idempotency(owner_token: str):
    created = _create(owner_token)
    sid, capability = created["session"]["id"], created["capability"]
    assert (
        client.get(
            f"/review-next/{sid}",
            headers={"Authorization": f"Bearer {owner_token}", "Origin": ORIGIN},
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/v1/review-next/{sid}", headers={"Authorization": f"Review {capability}"}
        ).status_code
        == 401
    )
    denied = client.get(
        f"/review-next/{sid}",
        headers=_reviewer(capability, origin="https://wrong.example.test"),
    )
    assert (
        denied.status_code == 404
        and "access-control-allow-origin" not in denied.headers
    )
    boot = client.get(f"/review-next/{sid}", headers=_reviewer(capability))
    assert boot.status_code == 200, boot.text
    assert boot.headers["access-control-allow-origin"] == ORIGIN
    assert boot.headers["cache-control"] == "private, no-store, max-age=0"
    assert boot.headers["referrer-policy"] == "no-referrer"
    assert boot.json()["session"]["mode"] == "next"

    payload = {
        "type": "element",
        "comment": "<img src=x onerror=alert(1)>",
        "target": {"pageUrl": f"{ORIGIN}/a?secret=gone", "selector": "main > p"},
        "baseRevision": 0,
    }
    annotation_operation = str(uuid.uuid4())
    saved = client.post(
        f"/review-next/{sid}/annotations",
        headers=_reviewer(capability, key=annotation_operation),
        json=payload,
    )
    retry = client.post(
        f"/review-next/{sid}/annotations",
        headers=_reviewer(capability, key=annotation_operation),
        json=payload,
    )
    assert saved.status_code == retry.status_code == 200
    assert retry.json() == saved.json()
    assert saved.json()["annotation"]["target"]["pageUrl"] == f"{ORIGIN}/a"
    stale = client.post(
        f"/review-next/{sid}/annotations",
        headers=_reviewer(capability, key=str(uuid.uuid4())),
        json={**payload, "baseRevision": 0},
    )
    assert stale.status_code == 409 and stale.json()["error"] == "revision_conflict"
    executable = client.post(
        f"/review-next/{sid}/annotations",
        headers=_reviewer(capability, key="annotation-js-url-0123456789"),
        json={
            "type": "group",
            "comment": "no",
            "target": {"members": [{"href": "javascript:alert(1)"}]},
            "baseRevision": 1,
        },
    )
    assert executable.status_code == 422

    preflight = client.options(
        f"/review-next/{sid}/annotations",
        headers={"Origin": ORIGIN, "Access-Control-Request-Headers": "authorization"},
    )
    assert (
        preflight.status_code == 204
        and preflight.headers["access-control-allow-origin"] == ORIGIN
    )
    unknown = client.options(
        "/review-next/not-a-session/annotations", headers={"Origin": ORIGIN}
    )
    assert (
        unknown.status_code == 204
        and "access-control-allow-origin" not in unknown.headers
    )
    owner_preflight = client.options(
        f"/v1/review-next/{sid}",
        headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in owner_preflight.headers

    finished = client.post(
        f"/review-next/{sid}/finish",
        headers=_reviewer(capability, key="finish-review-0123456789"),
        json={"baseRevision": 1},
    )
    assert (
        finished.status_code == 200
        and finished.json()["session"]["status"] == "finished"
    )
    assert (
        client.get(f"/review-next/{sid}", headers=_reviewer(capability)).status_code
        == 200
    )
    reopened = client.post(
        f"/v1/review-next/{sid}/reopen",
        headers=_owner(owner_token, "reopen-review-0123456789"),
        json={"baseRevision": 2},
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["session"]["status"] == "reopened"
    assert (
        client.get(f"/review-next/{sid}", headers=_reviewer(capability)).status_code
        == 404
    )
    assert (
        client.get(
            f"/review-next/{sid}", headers=_reviewer(reopened.json()["capability"])
        ).status_code
        == 200
    )
    with session_scope() as db:
        session = db.query(ReviewNextSession).filter_by(session_id=sid).one()
        for event in db.query(ReviewNextEvent).filter_by(session_id=session.id):
            assert capability not in str(event.payload)
            assert capability not in str(event.response)


def test_same_origin_fetch_metadata_and_no_proxy_origin_override(
    owner_token: str, monkeypatch: pytest.MonkeyPatch
):
    created = _create(owner_token)
    sid, capability = created["session"]["id"], created["capability"]
    auth = {"Authorization": f"Review {capability}"}
    assert client.get(f"/review-next/{sid}", headers=auth).status_code == 404
    monkeypatch.setattr(review_public.settings, "public_base_url_review", ORIGIN)
    assert client.get(f"/review-next/{sid}", headers={**auth, "X-Review-Proxy-Origin": ORIGIN}).status_code == 404
    assert client.get(f"/review-next/{sid}", headers={**auth, "Sec-Fetch-Site": "same-origin"}).status_code == 200
    response = client.get(f"/review-next/{sid}", headers={**auth, "Origin": "https://wrong.example.test", "Sec-Fetch-Site": "same-origin"})
    assert response.status_code == 404
    assert "access-control-allow-origin" not in response.headers


def test_url_safe_ids_and_no_legacy_router(owner_token: str):
    assert client.get("/v1/review", headers=_owner(owner_token)).status_code == 404
    invalid = client.post(
        "/v1/review-next?mode=next",
        headers=_owner(owner_token, f"bad-id-{uuid.uuid4().hex}"),
        json={"mode": "next", "id": "bad/id", "pageUrl": f"{ORIGIN}/"},
    )
    assert invalid.status_code == 422


def test_passcode_cors_asset_allowlist_and_rate_limit(owner_token: str, monkeypatch: pytest.MonkeyPatch):
    key = f"passcode-{uuid.uuid4().hex}"
    response = client.post(
        "/v1/review-next?mode=next",
        headers=_owner(owner_token, key),
        json={
            "mode": "next",
            "pageUrl": f"{ORIGIN}/passcode",
            "passcode": "temporary-test-passcode",
        },
    )
    assert response.status_code == 200
    sid, capability = response.json()["sessionId"], response.json()["capability"]
    needs_passcode = client.get(f"/review-next/{sid}", headers=_reviewer(capability))
    assert needs_passcode.status_code == 404
    assert needs_passcode.headers["access-control-allow-origin"] == ORIGIN
    assert client.get(
        f"/review-next/{sid}",
        headers={**_reviewer(capability), "X-Review-Passcode": "temporary-test-passcode"},
    ).status_code == 200

    asset = response.json()["assetUrl"].rsplit("/", 1)[-1]
    served = client.get(f"/review-next/assets/{asset}")
    assert served.status_code == 200
    assert served.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert served.headers["x-content-type-options"] == "nosniff"
    manifest = json.loads((Path(__file__).parents[1] / "static/ui-review-next.manifest.json").read_text())
    for retained in manifest["assets"]:
        assert client.get(f"/review-next/assets/{retained['asset']}").status_code == 200
    assert client.get("/review-next/assets/claw-review.js").status_code == 404

    _review_attempts.clear()
    monkeypatch.setattr(review_public, "PEER_RATE_LIMIT", REVIEW_RATE_LIMIT)
    headers = _reviewer("definitely-not-a-capability", origin="https://rate.example.test")
    for _ in range(REVIEW_RATE_LIMIT):
        assert client.get("/review-next/rate-limit-test", headers=headers).status_code == 404
    assert client.get("/review-next/rate-limit-test", headers=headers).status_code == 429
    _review_attempts.clear()


def test_tool_schema_and_nested_url_safety():
    selector = {"selector": "main > p"}
    valid = {
        "element": selector,
        "text": {**selector, "text": {"quote": "old"}, "suggestion": {"before": "old", "after": "new"}},
        "area": {**selector, "area": {"x": 1, "y": 2, "width": 20, "height": 30, "viewport": {"width": 390, "height": 844}}},
        "group": {**selector, "group": [{"selector": "main > p"}, {"selector": "main > h1"}]},
        "pause": {**selector, "pause": {"action": "pause", "animationCount": 2}},
        "layout": {
            **selector,
            "layout": {
                "intent": "move",
                "dx": 24,
                "dy": -24,
                "destinationTarget": {"selector": "#destination"},
            },
        },
    }
    for annotation_type, target in valid.items():
        assert validate_target(annotation_type, target) == target
    with pytest.raises(ValueError):
        validate_target("group", {**selector, "group": [selector]})
    with pytest.raises(ValueError):
        validate_target(
            "layout",
            {
                **selector,
                "layout": {
                    "intent": "move",
                    "dx": 120,
                    "dy": 0,
                    "destinationTarget": {"selector": "#destination"},
                },
            },
        )
    with pytest.raises(ValueError):
        validate_target(
            "layout",
            {**selector, "layout": {"intent": "move", "dx": 0, "dy": 0}},
        )
    with pytest.raises(ValueError):
        validate_target(
            "layout",
            {
                **selector,
                "layout": {
                    "intent": "move",
                    "dx": 0,
                    "dy": 0,
                    "destinationTarget": selector,
                },
            },
        )
    assert sanitize_page_url(f"{ORIGIN}/routed?tab=billing&token=gone#review=gone") == f"{ORIGIN}/routed?tab=billing"


def test_text_suggestion_is_optional_but_validated_when_present():
    text_target = {"selector": "main > p", "text": {"quote": "old"}}
    assert validate_target("text", text_target) == text_target

    suggested = {
        **text_target,
        "suggestion": {"before": "old", "after": "new"},
    }
    assert validate_target("text", suggested) == suggested

    with pytest.raises(ValueError):
        validate_target("text", {**text_target, "suggestion": "new"})
    with pytest.raises(ValueError):
        validate_target(
            "text",
            {**text_target, "suggestion": {"before": "old", "after": "old"}},
        )
    with pytest.raises(ValueError):
        validate_target("text", {**text_target, "suggestion": {"before": "old"}})


def test_agent_reply_state_fix_summary_watch_and_separate_revisions(
    owner_token: str, agent_identity: tuple[str, str]
):
    agent_token, agent_id = agent_identity
    created = client.post(
        "/v1/review-next?mode=next",
        headers=_owner(owner_token, f"agent-create-{uuid.uuid4().hex}"),
        json={
            "mode": "next",
            "id": f"next-agent-{uuid.uuid4().hex[:10]}",
            "pageUrl": f"{ORIGIN}/agent",
            "assignedAgentId": agent_id,
        },
    ).json()
    sid, capability = created["sessionId"], created["capability"]
    first = client.post(
        f"/review-next/{sid}/annotations",
        headers=_reviewer(capability, key=f"agent-note-1-{uuid.uuid4().hex}"),
        json={"id": "note-agent-one", "type": "element", "comment": "One", "target": {"selector": "main > p"}, "baseRevision": 0},
    )
    second = client.post(
        f"/review-next/{sid}/annotations",
        headers=_reviewer(capability, key=f"agent-note-2-{uuid.uuid4().hex}"),
        json={"id": "note-agent-two", "type": "element", "comment": "Two", "target": {"selector": "main > h1"}, "baseRevision": 1},
    )
    assert first.status_code == second.status_code == 200
    edit = client.patch(
        f"/review-next/{sid}/annotations/note-agent-one",
        headers={**_reviewer(capability, key=f"edit-agent-{uuid.uuid4().hex}"), "If-Match": "1"},
        json={"revision": 1, "baseRevision": 2, "comment": "One edited"},
    )
    assert edit.status_code == 200 and edit.json()["annotation"]["revision"] == 2

    reply_key = f"reply-agent-{uuid.uuid4().hex}"
    replied = client.post(
        f"/v1/review-next/{sid}/annotations/note-agent-one/replies",
        headers=_owner(agent_token, reply_key),
        json={"text": "Builder reply", "baseRevision": 3},
    )
    assert replied.status_code == 200
    assert replied.json()["annotation"]["replies"][-1]["text"] == "Builder reply"
    fixed_key = f"fix-agent-{uuid.uuid4().hex}"
    fixed_body = {"state": "fixed", "fixSummary": "Fixed <script>alert(1)</script>", "baseRevision": 4}
    fixed = client.post(
        f"/v1/review-next/{sid}/annotations/note-agent-one/state",
        headers=_owner(agent_token, fixed_key),
        json=fixed_body,
    )
    replay = client.post(
        f"/v1/review-next/{sid}/annotations/note-agent-one/state",
        headers=_owner(agent_token, fixed_key),
        json=fixed_body,
    )
    assert fixed.status_code == replay.status_code == 200
    assert fixed.json() == replay.json()
    assert fixed.json()["annotation"]["fixSummary"] == fixed_body["fixSummary"]
    watch = client.get(f"/v1/review-next/{sid}/events?after=0", headers=_owner(agent_token))
    assert watch.status_code == 200
    assert any(event["annotationId"] == "note-agent-one" for event in watch.json()["events"])
    public = client.get(f"/review-next/{sid}", headers=_reviewer(capability))
    current = next(item for item in public.json()["annotations"] if item["id"] == "note-agent-one")
    assert current["fixSummary"] == fixed_body["fixSummary"]
    assert client.post(
        f"/review-next/{sid}/annotations/note-agent-one/state",
        headers=_reviewer(capability, key="reviewer-cannot-state"),
        json={"state": "open", "baseRevision": 5},
    ).status_code in {404, 405}


def test_grant_revoke_finish_replay_and_event(owner_token: str):
    created = _create(owner_token, f"grant-create-{uuid.uuid4().hex}")
    sid, capability = created["sessionId"], created["capability"]
    issue_key = f"grant-issue-{uuid.uuid4().hex}"
    issued = client.post(
        f"/v1/review-next/{sid}/grants",
        headers=_owner(owner_token, issue_key),
        json={"baseRevision": 0, "origin": ORIGIN},
    )
    issued_replay = client.post(
        f"/v1/review-next/{sid}/grants",
        headers=_owner(owner_token, issue_key),
        json={"baseRevision": 0, "origin": ORIGIN},
    )
    assert issued.status_code == issued_replay.status_code == 200
    assert issued.json()["capability"] == issued_replay.json()["capability"]
    assert issued.headers["cache-control"] == "private, no-store, max-age=0"
    grant_id = issued.json()["grant"]["id"]
    revoke_key = f"grant-revoke-{uuid.uuid4().hex}"
    revoked = client.request(
        "DELETE",
        f"/v1/review-next/{sid}/grants/{grant_id}",
        headers=_owner(owner_token, revoke_key),
        json={"baseRevision": 1},
    )
    assert revoked.status_code == 200
    finish_key = f"finish-replay-{uuid.uuid4().hex}"
    finished = client.post(
        f"/review-next/{sid}/finish",
        headers=_reviewer(capability, key=finish_key),
        json={"baseRevision": 2},
    )
    finish_replay = client.post(
        f"/review-next/{sid}/finish",
        headers=_reviewer(capability, key=finish_key),
        json={"baseRevision": 2},
    )
    assert finished.status_code == finish_replay.status_code == 200
    assert finished.json() == finish_replay.json()
    with session_scope() as db:
        session = db.query(ReviewNextSession).filter_by(session_id=sid).one()
        event = db.query(ReviewNextEvent).filter_by(session_id=session.id, operation="finish").one()
        assert event.payload["builderNotification"] == "requested"
        for row in db.query(ReviewNextEvent).filter_by(session_id=session.id):
            assert issued.json()["capability"] not in str(row.response)

    archived = client.post(
        f"/v1/review-next/{sid}/archive",
        headers=_owner(owner_token, f"archive-{uuid.uuid4().hex}"),
        json={"baseRevision": 3},
    )
    assert archived.status_code == 200
    preflight = client.options(
        f"/review-next/{sid}", headers={"Origin": ORIGIN}
    )
    assert preflight.status_code == 204
    assert "access-control-allow-origin" not in preflight.headers

    assert client.get(
        f"/v1/review-next/{sid}", headers=_owner(owner_token)
    ).headers["cache-control"] == "private, no-store, max-age=0"


def test_oversize_request_rejected_before_json_parsing(owner_token: str):
    response = client.post(
        "/v1/review-next?mode=next",
        headers=_owner(owner_token, "oversize-test-key"),
        content=b"{" + b"x" * (64 * 1024),
    )
    assert response.status_code == 413


def test_preview_url_redacts_sensitive_query_and_preserves_ipv6():
    assert sanitize_page_url("http://[::1]:8782/?view=grid&sig=dummy&session=dummy#ignored") == "http://[::1]:8782/?view=grid"
    with pytest.raises(ValueError):
        sanitize_page_url("https://@example.test/")
    with pytest.raises(ValueError):
        sanitize_page_url("http://preview.example.test/")
