"""Small, deliberately strict helpers for the Review Next public boundary."""

import hashlib
import hmac
import json
import math
import re
import secrets
import time
from collections import OrderedDict, deque
from datetime import UTC, datetime
from ipaddress import ip_address
from threading import Lock
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import HTTPException, Request, status

MAX_COMMENT = 8_000
MAX_TEXT = 1_000
MAX_TARGET_BYTES = 24 * 1024
VALID_TYPES = {"element", "text", "area", "group", "pause", "layout"}
VALID_STATES = {"open", "acknowledged", "fixed", "dismissed", "reopened"}
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
REVIEW_RATE_LIMIT = 90
PEER_RATE_LIMIT = 1200
REVIEW_RATE_WINDOW_SECONDS = 60.0
MAX_RATE_KEYS = 4096
_review_attempts: OrderedDict[str, deque[float]] = OrderedDict()
_review_attempts_lock = Lock()


def now() -> datetime:
    return datetime.now(UTC)


def capability_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def issue_capability() -> str:
    return secrets.token_urlsafe(32)


def secure_transport(scheme: str, host: str) -> bool:
    if scheme == "https" or host == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_origin(value: object) -> str:
    if not isinstance(value, str) or len(value) > 512 or value == "null" or "\\" in value or any(ord(c) <= 32 for c in value):
        raise ValueError("origin must be an exact http(s) origin")
    parts = urlsplit(value)
    if (
        parts.scheme not in {"http", "https"}
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
    ):
        raise ValueError("origin must be an exact http(s) origin")
    if parts.path not in {"", "/"} or parts.query or parts.fragment:
        raise ValueError("origin must be an exact http(s) origin")
    try:
        host = parts.hostname.encode("idna").decode("ascii").lower()
        port = parts.port
    except (UnicodeError, ValueError) as exc:
        raise ValueError("origin must be an exact http(s) origin") from exc
    if not secure_transport(parts.scheme, host):
        raise ValueError("HTTPS is required outside loopback")
    if ":" in host:
        host = f"[{host}]"
    if (parts.scheme == "https" and port == 443) or (
        parts.scheme == "http" and port == 80
    ):
        port = None
    return f"{parts.scheme}://{host}{f':{port}' if port is not None else ''}"


def sanitize_page_url(value: object) -> str:
    if not isinstance(value, str) or len(value) > 2_000 or "\\" in value or any(ord(c) <= 32 for c in value):
        raise ValueError("pageUrl must be a bounded http(s) URL")
    parts = urlsplit(value)
    if (
        parts.scheme not in {"http", "https"}
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
    ):
        raise ValueError("pageUrl must be a bounded http(s) URL")
    try:
        host = parts.hostname.encode("idna").decode("ascii").lower()
        port = parts.port
    except (UnicodeError, ValueError) as exc:
        raise ValueError("pageUrl must be a bounded http(s) URL") from exc
    if not secure_transport(parts.scheme, host):
        raise ValueError("HTTPS is required outside loopback")
    if ":" in host:
        host = f"[{host}]"
    netloc = host if port is None else f"{host}:{port}"
    sensitive = {
        "token", "key", "secret", "password", "passcode", "review", "auth",
        "authorization", "code", "credential", "signature", "session", "email", "jwt",
    }
    try:
        pairs = parse_qsl(parts.query, keep_blank_values=True, max_num_fields=50)
    except ValueError as exc:
        raise ValueError("pageUrl has too many query parameters") from exc
    query = urlencode(
        [
            (key, item)
            for key, item in pairs
            if not any(
                marker in "".join(character for character in key.lower() if character.isalnum())
                for marker in sensitive
            ) and key.lower() != "sig"
        ],
        doseq=True,
    )
    sanitized = urlunsplit((parts.scheme, netloc, parts.path or "/", query, ""))
    if len(sanitized) > 2_000:
        raise ValueError("pageUrl must be a bounded http(s) URL")
    return sanitized


def origin_from_page_url(page_url: str) -> str:
    parts = urlsplit(page_url)
    return normalize_origin(f"{parts.scheme}://{parts.netloc}")


def hash_passcode(passcode: str) -> str:
    if not isinstance(passcode, str) or not 1 <= len(passcode) <= 256:
        raise ValueError("passcode must be 1-256 characters")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        passcode.encode("utf-8"), salt=salt, n=2**14, r=8, p=1
    ).hex()
    return f"scrypt${salt.hex()}${digest}"


def passcode_matches(passcode: str | None, encoded: str | None) -> bool:
    if encoded is None:
        return True
    if not isinstance(passcode, str) or not 1 <= len(passcode) <= 256:
        return False
    try:
        algorithm, salt_hex, expected = encoded.split("$", 2)
        if algorithm != "scrypt":
            return False
        actual = hashlib.scrypt(
            passcode.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1
        ).hex()
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError):
        return False


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def request_hash(value: object) -> str:
    from app.core.settings import get_settings

    key = bytes.fromhex(get_settings().grant_signing_key.get_secret_value())
    data = b"ui-review-idempotency\x00" + canonical_json(value).encode("utf-8")
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def review_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="review unavailable"
    )


def enforce_reviewer_rate(key: str, limit: int = REVIEW_RATE_LIMIT) -> None:
    """Bound capability/passcode attempts and reviewer event floods per process."""
    current = time.monotonic()
    cutoff = current - REVIEW_RATE_WINDOW_SECONDS
    with _review_attempts_lock:
        attempts = _review_attempts.setdefault(key, deque())
        while attempts and attempts[0] <= cutoff:
            attempts.popleft()
        if len(attempts) >= limit:
            raise HTTPException(status_code=429, detail="review temporarily unavailable")
        attempts.append(current)
        _review_attempts.move_to_end(key)
        if len(_review_attempts) > MAX_RATE_KEYS:
            _review_attempts.popitem(last=False)


def require_idempotency(request: Request) -> str:
    value = request.headers.get("Idempotency-Key")
    if not value or len(value) > 128:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    return value


def _safe_target(value: object, depth: int = 0) -> object:
    if depth > 5:
        raise ValueError("target is nested too deeply")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("target number must be finite")
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) > MAX_TEXT:
            raise ValueError("target text is too long")
        return value
    if isinstance(value, list):
        if len(value) > 20:
            raise ValueError("target list is too long")
        return [_safe_target(item, depth + 1) for item in value]
    if isinstance(value, dict):
        if len(value) > 30:
            raise ValueError("target has too many fields")
        cleaned: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key) > 64:
                raise ValueError("target field is invalid")
            # This is an envelope, not a captured DOM/style dump.  Reject these
            # categories outright even when they would fit byte limits.
            lowered = key.lower()
            if "html" in lowered or lowered in {"style", "computedstyle", "script"}:
                raise ValueError("target contains forbidden captured content")
            cleaned[key] = _safe_target(item, depth + 1)
        return cleaned
    raise ValueError("target must contain JSON primitives only")


def sanitize_target(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("target must be an object")
    cleaned = _safe_target(value)
    assert isinstance(cleaned, dict)

    def clean_urls(item: object, key: str | None = None) -> object:
        if isinstance(item, dict):
            return {
                child_key: clean_urls(child, child_key)
                for child_key, child in item.items()
            }
        if isinstance(item, list):
            return [clean_urls(child, key) for child in item]
        if (
            isinstance(item, str)
            and key
            and key.lower() in {"pageurl", "url", "href", "sourceurl"}
        ):
            return sanitize_page_url(item)
        if isinstance(item, str) and key and key.lower() in {"route", "path"}:
            # Routes are stored as inert same-page paths.  Never preserve an executable or
            # cross-origin scheme under a less obvious target-envelope field.
            parsed = urlsplit(item)
            if parsed.scheme or parsed.netloc or not item.startswith("/") or "\\" in item:
                raise ValueError("target route must be a same-origin path")
            return parsed.path
        return item

    cleaned = clean_urls(cleaned)
    assert isinstance(cleaned, dict)
    encoded = canonical_json(cleaned).encode("utf-8")
    if len(encoded) > MAX_TARGET_BYTES:
        raise ValueError("target is too large")
    return cleaned


def _selector(target: dict) -> str:
    selector = target.get("selector")
    if (
        not isinstance(selector, str)
        or not 1 <= len(selector) <= 512
        or any(character in selector for character in "{};\x00\r\n")
    ):
        raise ValueError("target requires a bounded structural selector")
    return selector


def _number(value: object, *, minimum: float, maximum: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be numeric")
    result = float(value)
    if not math.isfinite(result) or result < minimum or result > maximum:
        raise ValueError(f"{name} is out of bounds")
    return result


def validate_target(annotation_type: str, target: dict) -> dict:
    """Enforce the frozen minimum envelope for each annotation tool."""
    _selector(target)
    if annotation_type == "element":
        return target
    if annotation_type == "text":
        text = target.get("text")
        suggestion = target.get("suggestion")
        if not isinstance(text, dict) or not isinstance(text.get("quote"), str) or not text["quote"].strip():
            raise ValueError("text target requires an exact quote")
        if suggestion is None:
            return target
        if not isinstance(suggestion, dict):
            raise ValueError("text target requires before/after suggestion")
        before, after = suggestion.get("before"), suggestion.get("after")
        if not all(isinstance(value, str) and len(value) <= MAX_TEXT for value in (before, after)) or before == after:
            raise ValueError("text suggestion requires distinct bounded before/after text")
        return target
    if annotation_type == "area":
        area = target.get("area")
        if not isinstance(area, dict) or not isinstance(area.get("viewport"), dict):
            raise ValueError("area target requires geometry and viewport")
        viewport = area["viewport"]
        width = _number(viewport.get("width"), minimum=1, maximum=20_000, name="viewport width")
        height = _number(viewport.get("height"), minimum=1, maximum=20_000, name="viewport height")
        _number(area.get("x"), minimum=0, maximum=width, name="area x")
        _number(area.get("y"), minimum=0, maximum=height, name="area y")
        _number(area.get("width"), minimum=1, maximum=width, name="area width")
        _number(area.get("height"), minimum=1, maximum=height, name="area height")
        return target
    if annotation_type == "group":
        members = target.get("group")
        if not isinstance(members, list) or not 2 <= len(members) <= 20:
            raise ValueError("group target requires 2-20 member targets")
        selectors = []
        for member in members:
            if not isinstance(member, dict):
                raise ValueError("group members must be target envelopes")
            selectors.append(_selector(member))
        if len(set(selectors)) != len(selectors):
            raise ValueError("group target members must be distinct")
        return target
    if annotation_type == "pause":
        pause = target.get("pause")
        if not isinstance(pause, dict) or pause.get("action") != "pause":
            raise ValueError("pause target requires pause metadata")
        _number(pause.get("animationCount"), minimum=0, maximum=10_000, name="animation count")
        return target
    if annotation_type == "layout":
        layout = target.get("layout")
        if not isinstance(layout, dict) or layout.get("intent") not in {"move", "rearrange"}:
            raise ValueError("layout target requires move or rearrange intent")
        _number(layout.get("dx"), minimum=-96, maximum=96, name="layout dx")
        _number(layout.get("dy"), minimum=-96, maximum=96, name="layout dy")
        destination = layout.get("destinationTarget")
        if not isinstance(destination, dict):
            raise ValueError("layout target requires a destination target")
        destination_selector = _selector(destination)
        if destination_selector == _selector(target):
            raise ValueError("layout destination must differ from its source")
        return target
    raise ValueError("invalid annotation type")


def require_revision(request: Request, body: dict, *, key: str = "baseRevision") -> int:
    raw = request.headers.get("If-Match")
    value: object = body.get(key)
    if raw is not None:
        raw = raw.strip().strip('"')
        try:
            header_value = int(raw)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="If-Match must be an integer revision"
            ) from exc
        if value is not None and value != header_value:
            raise HTTPException(
                status_code=400, detail="revision and If-Match disagree"
            )
        value = header_value
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise HTTPException(
            status_code=428, detail="current revision or If-Match is required"
        )
    return value
