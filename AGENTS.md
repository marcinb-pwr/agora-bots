# AGENTS.md

This file is the working agreement for humans and coding agents in this repository. It
applies to the entire repository. A more deeply nested `AGENTS.md` may add or override
rules for its subtree.

## Mission and product invariants

Build Agora Bots as a reproducible, searchable observatory for agent-to-agent dialogue.
Preserve these invariants unless an accepted architecture decision record (ADR) changes
them:

1. A person configures and starts a session but cannot add dialogue after it starts.
2. Standard sessions contain two bots whose turns strictly alternate.
3. Every session is bounded by explicit message, token, duration, and cost limits.
4. Canonical conversation events are append-only. Search, transcript, embedding, and
   dashboard records are disposable projections.
5. Bot and scenario versions are immutable once referenced by a session.
6. Persist enough provenance to interpret a run, but never persist provider secrets.
7. Model output is untrusted data and must not be executed or rendered as trusted HTML.
8. Every search result and aggregate must be traceable to canonical transcript spans;
   exact, dictionary, and semantic evidence must remain distinguishable.

## Source of truth and precedence

- Read the root `README.md`, relevant ADRs, and every applicable `AGENTS.md` before
  changing code.
- User instructions override this file. Nested `AGENTS.md` files override it only in
  their directory subtree.
- If requested work conflicts with a product invariant, security control, or existing
  ADR, stop and describe the conflict rather than silently working around it.
- Do not invent product decisions. Record an explicit assumption in the PR when a choice
  is reversible; request a decision or propose an ADR when it is expensive to reverse.

## Expected repository boundaries

Follow the target layout documented in `README.md`:

- `apps/web` owns presentation and browser behavior.
- `apps/api` owns HTTP/SSE transport, authentication enforcement, and input validation.
- `apps/worker` owns queued orchestration and projection execution.
- `packages/domain` owns provider-independent rules and the session state machine.
- `packages/providers` owns provider adapters; SDK types do not escape this package.
- `packages/db` owns schema, migrations, and repositories, not business rules.
- `packages/contracts` owns versioned wire/event schemas.
- `packages/analysis` owns rebuildable analysis pipelines, never canonical messages.

Keep dependencies directed inward. Domain code must remain deterministic and must not
import a framework, provider SDK, queue, or database driver. Prefer a modular monolith;
do not introduce a new deployable service or infrastructure system without an ADR and
measured need.

## How agents should work

1. **Inspect first.** Check repository status, applicable instructions, nearby patterns,
   package scripts, and tests. Do not overwrite unrelated or uncommitted work.
2. **Plan a vertical change.** State acceptance criteria and identify contract, schema,
   security, migration, observability, and documentation effects.
3. **Make the smallest coherent change.** Avoid speculative abstractions and drive-by
   formatting. Prefer boring, explicit code with clear ownership.
4. **Validate at boundaries.** Parse external input once with shared schemas. Keep typed
   domain values internally and return stable, sanitized errors externally.
5. **Test behavior.** Add or update tests with production code. Use deterministic fake
   providers; tests must not call paid/live model APIs or rely on network access.
6. **Run the narrow checks, then the repository checks.** Report exact commands and any
   checks not run. Never claim success for a command that was not executed.
7. **Review the diff.** Look for leaked secrets/PII, unsafe rendering, unbounded work,
   nondeterminism, broken idempotency, incompatible migrations, and unrelated changes.
8. **Update documentation.** Keep the README/API docs/ADRs aligned with user-visible,
   operational, or architectural behavior.

## Coding conventions

These are bootstrap defaults until automated configuration provides stricter rules:

- Use TypeScript in strict mode. Avoid `any`; use `unknown` and narrow it.
- Prefer small pure functions, explicit return types at exported boundaries, and
  dependency injection for clocks, IDs, provider clients, queues, and storage.
- Validate environment variables at startup. Never use a silent production default for
  a secret, budget, region, retention duration, or externally reachable URL.
- Use structured logs with stable event names and correlation fields. Do not log entire
  prompts, completions, credentials, authorization headers, or raw provider responses.
- Represent timestamps as UTC ISO 8601 at wire boundaries and money as integer
  microunits with an explicit currency. Never use floating point for billing.
- Use UUIDv7 IDs where supported. Do not expose sequential database IDs publicly.
- Version persisted events and analysis algorithms. Consumers must tolerate additive
  fields; breaking event changes require a new schema version and migration strategy.
- Comments should explain constraints and reasons, not narrate obvious syntax.
- Never put `try`/`catch` around imports.

Formatting and naming should be enforced by the repository toolchain once scaffolded.
Follow the established configuration rather than adding local exceptions.

## Conversation correctness

- Model a session with explicit transitions; reject invalid or repeated transitions.
- Use a database uniqueness constraint for `(session_id, sequence)` and an idempotency
  key for every turn/provider attempt. Assume all jobs can be delivered more than once.
- Acquire a renewable lease before advancing a session. A recovered worker must inspect
  committed state rather than trust job payload state.
- Check all run limits before and after a provider call. Persist normalized token usage,
  estimated/final cost, finish reason, and the exact stop reason.
- Preserve canonical text exactly. Normalization, tokenization, dictionaries, sentiment,
  and embeddings belong in versioned projections and must keep source offsets.
- Index searchable words and *k*-word passages as rebuildable positional projections.
  Frequency metrics must name the unit and denominator and retain source drill-down.
- Never use a provider's arbitrary stream fragments as semantic word/token boundaries.
- Cancellation is cooperative and idempotent. Partial output must be explicitly marked;
  it must not masquerade as a completed assistant message.

## Database and migrations

- Schema changes require a forward migration, relevant indexes/constraints, and an
  integration test. Never edit a migration that may have been applied; add another.
- Prefer transactional outbox/event insertion with state changes so a committed turn
  cannot be lost between PostgreSQL and Redis.
- Make projection jobs idempotent and restartable. Store projection/algorithm versions
  and provide a safe rebuild path.
- Consider visibility, moderation, retention, and deletion in every new projection.
  Deleted/private content must not remain discoverable in indexes, caches, embeddings,
  exports, logs, or analytics rows.
- Review query plans for search/list endpoints and avoid unbounded reads. Use cursor
  pagination and deterministic ordering.

## API and provider adapters

- Define request, response, event, and error schemas in `packages/contracts` before or
  alongside implementations. Generate OpenAPI from the runtime schemas.
- Mutating HTTP requests require authorization, validation, rate limiting where
  relevant, and idempotency semantics. Never place secrets or prompt text in URLs.
- SSE event IDs must be durable session sequence numbers and resume via `Last-Event-ID`.
  Send bounded heartbeats and handle slow/disconnected consumers without blocking runs.
- Provider adapters expose normalized streaming deltas, usage, finish reasons, errors,
  and capability metadata. Keep provider-specific payloads behind the adapter boundary.
- Classify retryable errors explicitly, use capped exponential backoff with jitter, and
  honor provider retry hints. Never retry an ambiguous paid request unless the adapter's
  idempotency/reconciliation behavior makes duplication safe.

## Testing and required checks

Every feature should cover the lowest practical layers:

- Unit tests for domain transitions, limit boundaries, text offsets, and normalization.
- Contract tests shared by the deterministic fake and every real provider adapter.
- PostgreSQL/Redis integration tests for constraints, leases, outbox delivery, retry,
  cancellation, recovery, deletion, and projection idempotency.
- Playwright tests for the critical create/watch/resume/search journey and accessibility.
- Property-based tests for state transitions, chunk reconstruction, Unicode offsets,
  and combinations of run limits where they add value.

Once workspace scripts exist, the expected pre-commit sequence is:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Run affected browser tests for UI changes and take a screenshot when requested or when
a perceptible web change is made. If a command cannot run because the project is not
scaffolded or an external dependency is unavailable, report it as a limitation rather
than weakening or deleting the check.

## Security and data governance checklist

Before completing a change, ask:

- Can untrusted model/user/provider content become HTML, a command, a URL fetch, a log
  injection, or a database query? Escape, parameterize, and constrain it.
- Could this leak system prompts, transcript content, personal data, credentials, or
  provider metadata through logs, errors, traces, metrics, caches, or public APIs?
- Are session creation, provider calls, streaming connections, retries, and analysis
  jobs bounded by quotas, timeouts, concurrency, and cost controls?
- Do authorization and visibility filters apply inside the query—not only in the UI?
- Does deletion propagate to every derived artifact? Is audit data minimized and
  retained according to policy?
- Are dependencies pinned and are generated files, fixtures, and examples free of real
  keys and transcript data?

Immediately stop and alert maintainers if a real secret or unapproved personal data is
found. Do not copy it into issues, commits, test output, or chat.

## Documentation and ADRs

Create an ADR in `docs/adr/NNNN-short-title.md` for durable choices such as persistence
semantics, authentication, public-data policy, provider retry behavior, deployment,
or a new service. Include context, decision, alternatives, consequences, security/cost
impact, and rollout/rollback plan.

Update the README when changing product scope, architecture, repository layout, setup,
commands, or operational expectations. Mark proposed behavior as proposed; do not
document unimplemented functionality as available.

## Commits and pull requests

- Keep commits focused and use an imperative subject (for example,
  `Document initial architecture`).
- The pull request description should include: problem/context, solution and boundaries,
  schema/API/architecture impact, security/privacy/cost impact, exact validation commands,
  screenshots for perceptible UI changes, rollout/rollback notes, and follow-up work.
- Link the relevant issue/ADR when one exists. Call out assumptions and migrations.
- Do not commit generated artifacts, credentials, local environment files, or unrelated
  changes. Do not bypass hooks or checks to make a commit pass.

## Definition of done

A change is done when its acceptance criteria are met, boundaries remain intact, tests
cover the behavior and failure paths, required checks pass (or limitations are reported),
documentation is current, observability is sufficient to operate it, data lifecycle and
cost are addressed, and the final diff contains no secrets or unrelated edits.
