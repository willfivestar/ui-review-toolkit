"""Admin-minted opaque API keys. There is no public registration route."""

import hashlib
import re
import secrets

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_session
from app.models.user import ApiToken, User


def generate_token() -> str:
    return "ur_" + secrets.token_hex(32)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def current_user(request: Request, db: Session = Depends(get_session)) -> User:
    auth = request.headers.get("Authorization", "")
    if re.fullmatch(r"Bearer ur_[0-9a-f]{64}", auth):
        user = db.scalar(
            select(User).join(ApiToken).where(
                ApiToken.token_hash == hash_token(auth[7:]),
                ApiToken.revoked_at.is_(None),
            )
        )
        if user is not None:
            return user
    raise HTTPException(status_code=401, detail="invalid API token")
