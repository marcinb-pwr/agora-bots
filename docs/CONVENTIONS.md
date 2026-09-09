# Versioning and migration conventions

These conventions apply before product schemas are introduced in M2. They make
rebuildability and provenance explicit without prematurely deciding event payloads or
research governance questions.

## Architecture decisions

- Store ADRs in `docs/adr/NNNN-short-title.md`, using the template in that directory.
- Never rewrite an accepted ADR. Add a successor that names the superseded record.
- A durable decision is not implemented until its ADR status is `accepted`.

## Database migrations

- Add migrations to `packages/db/migrations` as `NNNN-kebab-case.sql`; never edit an
  applied migration.
- Migrations run lexically, transactionally, and once. The runner stores a SHA-256
  checksum and refuses to continue if an applied file changed.
- Schema changes require an integration test and a documented rollback or forward-fix
  plan. Destructive changes must separate compatibility, backfill, and cleanup phases.

## Canonical event schemas

- Use dotted names such as `session.started` and an integer schema version beginning at
  `1`.
- Keep the envelope stable: event ID, session ID, durable sequence, event name, schema
  version, UTC occurrence timestamp, participant ID when applicable, and payload.
- Additive optional payload fields may retain a version. Removing, renaming, or changing
  semantics requires a new version and an explicit upcaster/read strategy.
- Canonical events are append-only. Corrections are new events, never updates.

## Dataset schemas

- A released dataset has a semantic release version and a manifest with schema version,
  corpus version, source commit, generated-at timestamp, file checksums, row counts,
  inclusion/exclusion counts, and every projection/analysis version.
- Published releases are immutable. Corrections produce a successor and an errata link.
- Fixtures must be synthetic or approved, contain no credentials or personal data, and
  state their language/Unicode purpose.

## Analysis versions

- Identify an analysis implementation as `<algorithm>@<integer>`, for example
  `unicode-word-boundaries@1`.
- Persist the exact version, configuration hash, input corpus version, and runtime/model
  provenance with every artifact.
- A semantic or offset-affecting change increments the integer. Rebuilds write alongside
  the old version and cut over only after validation; canonical text is never rewritten.
