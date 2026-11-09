"""Instance configuration. There are no shared credentials or service defaults."""

from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.review_next.security import normalize_origin


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="UI_REVIEW_", env_file=".env", extra="ignore")

    database_url: SecretStr
    grant_signing_key: SecretStr
    public_base_url_review: str = "http://127.0.0.1:8781"
    ui_review_finish_notification_mode: Literal["event", "disabled"] = "event"

    @field_validator("grant_signing_key")
    @classmethod
    def signing_key_is_hex(cls, value: SecretStr) -> SecretStr:
        raw = value.get_secret_value()
        if len(raw) != 64 or any(c not in "0123456789abcdefABCDEF" for c in raw):
            raise ValueError("grant_signing_key must be 32 random bytes encoded as hex")
        return value

    @field_validator("public_base_url_review")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        if any(c in value for c in '\"<>'):
            raise ValueError("public base URL must be an HTTP(S) origin")
        return normalize_origin(value)


@lru_cache
def get_settings() -> Settings:
    return Settings()
