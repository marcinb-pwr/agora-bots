# 0001 — Local M2 event persistence

- **Status:** accepted
- **Date:** 2026-09-09
- **Owners:** repository maintainers
- **Supersedes:** none

## Context

M2 needs durable recovery and replay, while the current product is intentionally limited
to local development. Production authentication, public-data policy, deployment, and a
paid provider are not required for this increment. Canonical dialogue must remain
append-only and every asynchronous delivery may happen more than once.

## Decision

PostgreSQL is the local source of truth. Immutable bot and scenario versions are selected
by sessions. Canonical events use a per-session sequence and idempotency key and cannot be
updated or deleted. Session state changes, events, and an outbox row are committed in one
transaction. A worker must hold a renewable PostgreSQL lease before advancing a session.
Provider attempts retain normalized usage, finish/error classification, and whether
output is partial; provider secrets and raw responses are never persisted.

Projections for messages and chunks are disposable and retain canonical event/span links.
The local API will use durable event sequence numbers as SSE IDs and replay events after
the supplied last sequence.

## Alternatives considered

- Redis as the canonical stream was rejected because session state and events would not
  share a transaction.
- Updating transcript rows in place was rejected because it prevents reliable recovery
  and provenance reconstruction.
- Production identity and publication workflows were deferred because this increment is
  explicitly local-only.

## Consequences

The local runner can recover from worker restarts by inspecting committed events and can
redeliver outbox work safely. PostgreSQL constraints carry core ordering/idempotency
rules. More schema and transaction code is required, and projection rebuilds must always
read canonical events.

## Security, privacy, and cost

The local service binds dependencies to loopback and should use synthetic transcripts.
No provider credential or raw response is stored. Every session has explicit message,
token, duration, and integer-microunit cost limits. Local-only does not authorize public
publication or use of real personal data.

## Rollout and rollback

Apply migration `0002-local-runner.sql` after the extension migration. Roll back during
local development by destroying the Compose volume. Once later migrations depend on
this schema, use forward fixes rather than editing the applied migration.
