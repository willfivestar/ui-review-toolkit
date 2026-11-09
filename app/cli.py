"""Provision or revoke API tokens from the instance console."""

import argparse
import json
import uuid

from sqlalchemy import select

from app.core.db import session_scope
from app.models.user import ApiToken, User
from app.review_next.security import now
from app.v1.auth import generate_token, hash_token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-token")
    create.add_argument("identity", help="Local account identifier, e.g. builder@example.test")
    create.add_argument("--label", default="console-issued")
    revoke = commands.add_parser("revoke-token")
    revoke.add_argument("token_id", type=uuid.UUID)
    args = parser.parse_args()
    with session_scope() as db:
        if args.command == "create-token":
            if not 1 <= len(args.identity) <= 320 or not 1 <= len(args.label) <= 120:
                parser.error("invalid identity or label length")
            user = db.scalar(select(User).where(User.email == args.identity))
            if user is None:
                user = User(email=args.identity, name=args.identity[:200], role="user")
                db.add(user)
                db.flush()
            raw = generate_token()
            token = ApiToken(user_id=user.id, token_hash=hash_token(raw), label=args.label)
            db.add(token)
            db.commit()
            print(json.dumps({"userId": str(user.id), "tokenId": str(token.id), "token": raw}))
        else:
            token = db.get(ApiToken, args.token_id)
            if token is None:
                parser.error("token not found")
            token.revoked_at = now()
            db.commit()
            print("Revoked.")


if __name__ == "__main__":
    main()
