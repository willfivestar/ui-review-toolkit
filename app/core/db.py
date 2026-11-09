from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.settings import get_settings

settings = get_settings()
engine = create_engine(settings.database_url.get_secret_value(), pool_pre_ping=True, hide_parameters=True, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency — yields a SQLAlchemy session and closes it after the request."""
    with SessionLocal() as session:
        yield session


@contextmanager
def session_scope() -> Iterator[Session]:
    """For CLI / one-off use outside a request."""
    with SessionLocal() as session:
        yield session
