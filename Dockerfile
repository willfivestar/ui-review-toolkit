FROM node:22-bookworm-slim AS client
WORKDIR /build/clients/ui-review
COPY clients/ui-review/package*.json ./
RUN npm ci --ignore-scripts
COPY clients/ui-review/src/next ./src/next
COPY clients/ui-review/scripts/build-next.mjs ./scripts/
RUN npm run build:next

FROM python:3.12-slim AS api
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /bin/uv
WORKDIR /srv
ENV PATH="/srv/.venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-cache
COPY app ./app
COPY --from=client /build/static ./static
USER 10001:10001
EXPOSE 8781
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8781", "--no-proxy-headers", "--no-access-log", "--limit-concurrency", "48"]
