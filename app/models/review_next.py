"""Additive UI Review Next persistence models.

These models intentionally do not reference the legacy ``reviews`` tables.  A Next
record is only ever addressed through its own route family and immutable ``mode`` /
``schema_version`` discriminator.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ReviewNextSession(Base):
    __tablename__ = "review_next_sessions"
    __table_args__ = (
        CheckConstraint("mode = 'next'", name="ck_review_next_sessions_mode"),
        CheckConstraint(
            "schema_version = 1", name="ck_review_next_sessions_schema_version"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    assigned_agent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    session_id: Mapped[str] = mapped_column(
        String(80), nullable=False, unique=True, index=True
    )
    mode: Mapped[str] = mapped_column(String(12), nullable=False, server_default="next")
    schema_version: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="1"
    )
    title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    page_url: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="open"
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class ReviewNextAccessGrant(Base):
    __tablename__ = "review_next_access_grants"
    __table_args__ = (
        UniqueConstraint(
            "capability_hash", name="uq_review_next_access_grants_capability_hash"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("review_next_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    capability_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    allowed_origin: Mapped[str] = mapped_column(String(512), nullable=False)
    passcode_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ReviewNextAnnotation(Base):
    __tablename__ = "review_next_annotations"
    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "annotation_id",
            name="uq_review_next_annotations_session_annotation",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("review_next_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    annotation_id: Mapped[str] = mapped_column(String(80), nullable=False)
    annotation_type: Mapped[str] = mapped_column(String(24), nullable=False)
    comment: Mapped[str] = mapped_column(Text, nullable=False)
    target: Mapped[dict] = mapped_column(JSONB, nullable=False)
    state: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="open"
    )
    fix_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class ReviewNextEvent(Base):
    __tablename__ = "review_next_events"
    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "actor_key",
            "operation",
            "idempotency_key",
            name="uq_review_next_events_idempotency",
        ),
        UniqueConstraint(
            "session_id", "event_number", name="uq_review_next_events_sequence"
        ),
        Index("ix_review_next_events_session_event", "session_id", "event_number"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("review_next_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    annotation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("review_next_annotations.id", ondelete="SET NULL"),
        nullable=True,
    )
    event_number: Mapped[int] = mapped_column(Integer, nullable=False)
    actor_key: Mapped[str] = mapped_column(String(96), nullable=False)
    operation: Mapped[str] = mapped_column(String(48), nullable=False)
    event_type: Mapped[str] = mapped_column(String(48), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    request_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    response: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
