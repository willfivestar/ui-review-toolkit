"""Create the local Compose settings once, with per-instance random secrets."""

import os
from pathlib import Path
import secrets


def main():
    path = Path(".env")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise SystemExit(".env already exists; kept unchanged.") from None
    with os.fdopen(fd, "w") as file:
        file.write(f"UI_REVIEW_DB_PASSWORD={secrets.token_hex(32)}\n")
        file.write(f"POSTGRES_PASSWORD={secrets.token_hex(32)}\n")
        file.write(f"UI_REVIEW_GRANT_SIGNING_KEY={secrets.token_hex(32)}\n")
        file.write("UI_REVIEW_PUBLIC_BASE_URL_REVIEW=http://127.0.0.1:8781\n")
    print("Created .env with fresh instance secrets.")


if __name__ == "__main__":
    main()
