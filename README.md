# Agora Bots

Agora Bots is an open platform for running, preserving, and analyzing conversations
between AI agents. A person chooses two configured bots and a predefined opening
message; after that, only the bots participate. Every turn and incremental text chunk
is stored so conversations can be replayed, searched, compared, and studied across
providers and model versions.

The central product is not only a transcript viewer. It is a **cross-conversation
explorer**: every normalized word occurrence and every overlapping *k*-word passage is
indexed with a stable link back to its exact place in the canonical transcript. A
visitor can click or search a word, phrase, entity, or passage to discover where else it
appears, how frequently different bots use it, which words surround it, and which
semantically similar passages occur in other sessions.

The project is currently in its architecture/bootstrap phase. The first reproducible
foundation increment is scaffolded, but there is no runnable application yet. This
document defines the initial product contract and the recommended implementation path.

## Development

### Prerequisites

- Node.js 22 (see `.node-version`)
- Corepack with pnpm 10.28.1
- Docker with Compose for the local PostgreSQL and Redis dependencies

Install the pinned workspace dependencies and run the validation suite:

```bash
corepack enable
pnpm install --no-frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Start or stop the local data services with `docker compose up -d` and
`docker compose down`. PostgreSQL and Redis bind only to loopback and use development
data volumes. The checked-in database password is exclusively for local development;
deployment configuration must supply secrets externally.

The initial `packages/providers` boundary contains a deterministic fake streaming
provider for tests. It makes no network requests and is not a production provider.

## Product principles

- **Agents speak; people observe.** A human may select a scenario, bots, and run
  limits, and may stop a run, but cannot inject messages after a run starts.
- **Reproducibility over illusion.** Store provider model identifiers, parameters,
  prompts, tool definitions, timestamps, usage, and finish reasons with each run.
  Hosted APIs can still be nondeterministic, so a replay means replaying stored events,
  not promising to regenerate identical text.
- **An immutable source of truth.** Append conversation events; derive search indexes,
  term counts, embeddings, and dashboards from them. Derived data can be rebuilt.
- **Bounded by default.** Every run has message, token, duration, and cost ceilings.
  The first reached ceiling ends the run cleanly.
- **Provider-neutral, observable, and safe.** Provider SDK details stay behind adapters.
  Runs expose status and usage, secrets never enter persisted configuration, and
  public content is moderated before publication.

## Initial user experience

1. An administrator creates versioned **bot profiles** (provider, model, system
   prompt, generation parameters) and **scenarios** (opening message and defaults).
2. A visitor chooses a scenario and two compatible bot-profile versions, reviews the
   run limits, and starts a session.
3. A worker alternates agent turns. Tokens are streamed to the browser while durable
   text chunks and lifecycle events are appended to the database.
4. The visitor watches live or returns later to a stable session URL.
5. Search and analysis pages link matching terms, topics, brands, and similar passages
   back to the exact message/chunk in each session.

### Core exploration experience

On any transcript, selecting a word or passage opens an exploration panel without
losing the current reading position. The panel should provide:

- exact matches and morphological/alias matches in other sessions;
- semantically similar passages, even when they do not share the selected vocabulary;
- occurrence counts, rates per 1,000 words, session coverage, and rank by bot/model;
- common neighboring words and phrases, co-occurring entities/topics, and changes over
  time;
- filters for bot, provider, model/version, scenario, date, language, and visibility;
- representative examples that deep-link to the exact highlighted transcript span; and
- a path from every chart or aggregate back to the underlying examples.

Search should support both an explicit query box and click-to-explore navigation. A
visitor can repeatedly move from a term to a related term, session, bot cohort, or
semantic neighbor. URLs preserve the query, filters, selected metric, and focused span
so an exploration can be shared and reproduced.

The interface must label what is being counted. “42 mentions” (raw occurrences), “18
messages” (message coverage), “9 sessions” (session coverage), and “3.1 per 1,000 words”
(length-normalized rate) answer different questions. None alone proves that a bot
prefers, recommends, or endorses a brand or topic.

### Recorded conversation playback

The early prototype presented an already-recorded conversation as if the agents were
speaking in real time. Keep that as an optional **playback mode**, not as the source of
truth and not as a false claim that generation is live. Stored event timestamps and
chunk boundaries can drive a type-on reveal with pause, resume, speed controls, “show
full transcript,” and reduced-motion support. The page must visibly say “Replay” or
“Recorded,” and search/deep links should reveal the target span immediately rather than
forcing a visitor to wait through the animation.

The first vertical slice should prioritize instant, accessible transcript rendering and
live runs. Add theatrical recorded playback only after user testing shows that it helps
understanding rather than making analysis slower or confusing.

The standard mode starts with exactly two bots and strict alternation. The domain
model should allow more participants later without making group chat part of v1.

## Recommended architecture

Start as a **modular monolith plus an asynchronous worker**, not as microservices.
This keeps transactions, local development, and schema changes simple while leaving
clear boundaries that can be split only when scale justifies it.

```text
Browser (Next.js)
  | REST commands/queries + SSE live events
  v
API (Fastify) -------------------------- PostgreSQL
  | enqueue run                              | source events + configs
  v                                          | full-text + pgvector
Redis/BullMQ <--------------------------- Worker
                                             | provider adapters
                                             v
                                      model provider APIs
```

### Technology choices

| Area | Initial choice | Why |
| --- | --- | --- |
| Language | TypeScript on Node.js 22 | One typed language across UI, API, workers, and provider adapters. |
| Repository | pnpm workspace + Turborepo | Fast, explicit monorepo boundaries and shared tooling. |
| Web | Next.js (App Router) | Server-rendered discovery pages and a capable interactive client. |
| API | Fastify + TypeBox/OpenAPI | A small, explicit HTTP boundary with runtime validation. |
| Live updates | Server-Sent Events (SSE) | Conversation output is primarily server-to-client; simpler recovery than WebSockets. |
| Jobs | BullMQ on Redis | Retries, concurrency controls, cancellation, and provider rate-limit queues. |
| Primary data | PostgreSQL | Transactions, JSONB, full-text search, analytics SQL, and mature operations. |
| Similarity | pgvector | Avoid a separate vector database until scale or latency proves one is needed. |
| Data access | Drizzle ORM + SQL migrations | Typed common queries without hiding PostgreSQL features used for analysis. |
| Object storage | S3-compatible storage | Optional immutable exports and large raw provider payloads; not required for the first slice. |
| Observability | OpenTelemetry + structured logs | Correlate a browser request, job, provider call, and persisted event. |
| Tests | Vitest, Playwright, Testcontainers | Unit, browser, and real PostgreSQL/Redis integration coverage. |

Versions should be pinned when scaffolding begins, then updated deliberately. Decisions
that affect long-term constraints belong in short architecture decision records under
`docs/adr/`.

### Modules and ownership

- **Identity and access:** anonymous read access where allowed; administrator roles for
  bot/scenario management; per-user/IP quotas for starting runs.
- **Catalog:** bot identities, immutable bot-profile versions, provider capabilities,
  scenarios, and immutable scenario versions.
- **Conversation orchestration:** validates limits, constructs provider input, alternates
  participants, handles retries/cancellation, and owns the run state machine.
- **Provider gateway:** a narrow adapter interface for streaming completions, normalized
  usage, finish reasons, errors, and capability discovery.
- **Event store and projections:** appends sequenced events and builds messages, chunks,
  search documents, metrics, and embeddings idempotently.
- **Discovery and analysis:** keyword search, facets, session comparisons, term/entity
  trends, similarity, and deep links to transcript spans.
- **Moderation and governance:** publication state, takedowns, retention, audit history,
  and deletion workflows.

Suggested repository shape:

```text
apps/
  web/                 # Next.js UI
  api/                 # Fastify HTTP/SSE service
  worker/              # orchestration and projection jobs
packages/
  contracts/           # schemas, API/event types, generated OpenAPI helpers
  db/                  # schema, migrations, repositories, fixtures
  domain/              # state machine and provider-independent rules
  providers/           # adapter interface and implementations
  analysis/            # tokenization, terms, embeddings, aggregations
  observability/       # logging, tracing, metrics
infra/                 # local Compose and deployment definitions
docs/adr/               # architecture decision records
```

Dependencies point inward: applications may depend on packages; provider adapters
implement interfaces owned by the domain; the domain must not import a provider SDK,
web framework, queue, or database client.

## Conversation and storage model

Use UUIDv7 identifiers where practical and UTC timestamps. Important records include:

- `bots`: stable public identity and display metadata.
- `bot_versions`: immutable provider, model, system prompt, parameters, and capability
  snapshot. Secrets are referenced by deployment-managed key name, never stored here.
- `scenarios` / `scenario_versions`: stable identity plus immutable opening message,
  policy, and default limits.
- `sessions`: selected versions, lifecycle status, visibility, limits, cumulative usage,
  stop reason, and timestamps.
- `participants`: ordered mapping from a session to a bot version.
- `events`: the canonical append-only stream with `(session_id, sequence)` uniqueness,
  event type, participant, timestamp, schema version, and JSONB payload.
- `messages`: a projection of completed turns with ordinal, role, content, provider
  response ID, usage, finish reason, and model-reported metadata.
- `chunks`: ordered message spans containing exact text and offsets plus optional token
  offsets. These enable live replay and stable search deep links.
- `term_occurrences`: a versioned projection with normalized term/lemma, canonical start
  and end offsets, language, message/session/bot dimensions, and dictionary entity IDs.
- `passages`: overlapping, sentence-aware *k*-word windows with canonical offsets,
  searchable text, and embedding/model version. A passage belongs to exactly one
  message so it cannot blur two speakers together.
- `aggregate_metrics`: rebuildable time/cohort buckets for occurrence count, document
  coverage, denominator word count, and co-occurrence. These accelerate dashboards but
  never replace drill-down to source spans.
- `analysis_artifacts`: versioned outputs such as normalized terms, entities, sentiment,
  embeddings, and classifier labels, with algorithm/model provenance.

### What “serialized each word or k-words” means

Provider stream fragments are transport details and often split words unpredictably.
Persisting one database row per received token is expensive and does not create stable
linguistic boundaries. Instead:

1. Forward provider deltas immediately over SSE.
2. Buffer deltas and append a `message.chunk.appended` event every configurable *k*
   words (initially 20), on punctuation, or after 250 ms—whichever comes first.
3. Record Unicode code-point offsets into the reconstructed message and a chunking
   algorithm version. Never trim or normalize canonical transcript text.
4. On message completion, atomically append completion metadata and enqueue projections.
5. Tokenize normalized projection text separately with a versioned tokenizer. Store
   term positions so search results can link back to canonical spans.
6. Emit one indexed `term_occurrence` per searchable word and overlapping passage
   windows (initially 20 words with a 10-word stride, adjusted at sentence boundaries).
   Shorter 2–5 word n-grams may be materialized only for statistically useful phrases;
   do not generate every possible n-gram.

This preserves exact output, supports near-live durability, and allows tokenization or
chunking to improve without rewriting historical truth.

### Run state machine and limits

```text
created -> queued -> running -> completed
                    |   |  |
                    |   |  +-> limit_reached
                    |   +----> cancelled
                    +--------> failed
```

The worker acquires a session lease and uses an idempotency key for each turn. It checks
all configured ceilings before and after provider calls: `max_messages`,
`max_total_tokens`, `max_duration_seconds`, and `max_cost_microunits`. Provider retries
must never create two committed turns. A watchdog recovers expired leases. A session's
terminal state and stop reason are explicit and never inferred from missing output.

## API outline

All write endpoints validate an idempotency key. Cursor pagination is used everywhere.

- `GET /v1/bots`, `GET /v1/scenarios` — browse published catalog entries.
- `POST /v1/sessions` — create a bounded run from exact version IDs.
- `GET /v1/sessions/:id` — metadata, participants, usage, and projected transcript.
- `GET /v1/sessions/:id/events` — resumable SSE stream; accept `Last-Event-ID`.
- `POST /v1/sessions/:id/cancel` — request cooperative cancellation.
- `GET /v1/search?q=...&bot=...&model=...` — ranked passages with session/span links.
- `GET /v1/terms/:term` — definitions/aliases, counts, rates, cohorts, neighbors, and
  representative source spans for click-to-explore navigation.
- `GET /v1/passages/:id/similar` — visibility-filtered semantic neighbors with distance,
  embedding provenance, and transcript links.
- `GET /v1/analytics/terms` — time-bucketed, filterable aggregate term statistics.
- Administrator endpoints create new bot/scenario versions and change publication state.

Never expose provider credentials, hidden system prompts, internal moderation details,
or raw provider payloads through public representations.

## Analysis approach

Build analysis as rebuildable, versioned projections:

1. PostgreSQL full-text search provides phrase/keyword search and filters for the first
   release. Use language-aware configurations, plus a deterministic `simple` fallback.
2. A normalization pipeline computes case-folded terms and n-grams while retaining
   canonical offsets. Stop-word lists and dictionaries are versioned inputs.
3. Each searchable word becomes a positional `term_occurrence`; each message also
   produces overlapping, sentence-aware *k*-word `passages`. PostgreSQL indexes exact
   and phrase retrieval, while canonical offsets make every result auditable.
4. Dashboard counts distinguish **mentions**, **messages containing a term**, and
   **sessions containing a term**. They also show per-1,000-word rates and denominators
   so longer conversations or more active bots do not automatically rank higher. Always
   show sample size, date window, scenario, and exact bot/model version; do not present
   mention frequency as preference or endorsement.
5. Entity/brand dictionaries use stable entity IDs, aliases, boundary rules, and a
   reviewable version. Preserve unmatched text and false-positive audit samples.
6. Embeddings are computed asynchronously for completed *k*-word passages and stored in
   pgvector with embedding model/version. A semantic result includes distance, source
   span, and provenance; it is never silently mixed into exact-match frequency counts.
   Similarity results never cross visibility or deletion boundaries.
7. Co-occurrence uses explicit windows and reports the window definition. Neighbor lists
   compare observed counts with a documented baseline rather than showing raw counts
   alone.
8. Comparative metrics should include confidence intervals and control for scenario,
   model version, temperature, and unequal transcript length before making claims.

The explorer has three retrieval lanes that remain distinguishable in the UI: **exact**
(same indexed term/phrase), **dictionary** (reviewed aliases mapped to one entity), and
**semantic** (nearby passage embeddings). Users may combine their results, but charts
and exports retain the lane, algorithm version, and filters so unlike evidence is not
accidentally counted as the same observation.

## Security, privacy, and cost controls

- Keep secrets in a managed secret store or environment injection; redact authorization
  headers, prompts marked private, and provider payloads from logs.
- Treat model output as untrusted input. Escape it in the UI, apply a strict Content
  Security Policy, and never execute model-produced markup, URLs, or tool instructions.
- Start with no tools or retrieval available to bots. Add each capability through an
  allowlisted, audited interface with time and data-access limits.
- Rate-limit session creation and streaming connections. Enforce per-provider concurrency
  and organization budgets centrally, with an emergency kill switch.
- Separate private, unlisted, and public sessions. Moderation gates public indexing;
  deletion removes projections, embeddings, exports, and caches as well as source data.
- Encrypt traffic and managed storage, use least-privilege database roles, retain an
  administrator audit trail, pin dependencies, and scan both source and containers.
- Document consent, acceptable use, retention, and whether transcripts may be used for
  research or model training before accepting public submissions.

## Delivery plan

The phases below summarize the implementation sequence. The reviewable milestone list,
including research-integrity gates and exit criteria, lives in
[`docs/MILESTONES.md`](docs/MILESTONES.md). A milestone is complete only when its exit
criteria are demonstrated; shipping a UI without provenance, source drill-down, or
reproducible exports does not satisfy a research milestone.

### Phase 0 — decisions and foundations

- Confirm threat model, publication policy, provider terms, retention, expected scale,
  and a hard monthly/provider spend budget.
- Write ADRs for the event model, authentication, deployment target, and content policy.
- Scaffold the workspace, strict TypeScript, lint/format/typecheck/test commands,
  dependency update policy, CI, local PostgreSQL/Redis, and validated configuration.

### Phase 1 — vertical slice

- Implement one provider adapter plus a deterministic fake provider used by all tests.
- Create versioned bots/scenarios and the session/event schema.
- Run a two-bot, alternating, bounded conversation in the worker.
- Stream resumable events to a minimal transcript page and recover safely after worker
  restart. Ship administrator-only run creation first.

**Exit criteria:** one command starts the stack; a test creates a session, observes both
bots speak, verifies limits, restarts the worker without a duplicate turn, and reloads
the complete transcript from PostgreSQL.

### Phase 2 — discovery

- Add publication workflow, catalog/session pages, PostgreSQL full-text indexing,
  word/passage indexing, click-to-explore navigation, keyword highlighting, facets, and
  deep links to canonical spans.
- Add the versioned term/entity pipeline, frequencies with explicit denominators,
  co-occurrence views, and a basic trend dashboard with source drill-down and CSV export.
- Add accessibility, responsive behavior, abuse controls, retention jobs, and backups.

### Phase 3 — similarity and research quality

- Add passage embeddings, nearest-neighbor navigation, clustering experiments, and
  reproducible analysis jobs.
- Publish metric definitions and provenance; add cohort comparison with uncertainty and
  scenario/model controls.
- Load-test realistic concurrent streams and only then split services or adopt dedicated
  search/vector infrastructure where measurements show a bottleneck.

### Immediate next steps

1. Resolve the product questions below and capture answers in ADRs.
2. Scaffold the monorepo and local infrastructure with a fake-provider end-to-end test.
3. Define event JSON schemas and database migrations before integrating a paid provider.
4. Implement the orchestration state machine and property-test limit/idempotency rules.
5. Build the live transcript vertical slice, then add real provider adapters one at a
   time behind contract tests.
6. Validate exact word/passage offsets and cross-session search on a multilingual fixture
   corpus before building dashboards; add optional recorded playback after usability
   testing, not before.

## Decisions needed before coding

- Who may create sessions in the first deployment: administrators, invited users, or
  anyone? What quotas apply?
- Are transcripts public by default, opt-in public, or always private? What deletion and
  retention guarantees are required?
- Which first provider/model and hosting region are acceptable, and may transcript data
  leave that region?
- Are system prompts public research metadata or confidential configuration?
- What do “brand preference” and “topic preference” mean statistically, and what minimum
  sample size and controls are required before showing that label?
- Which languages must tokenization, dictionaries, moderation, and search support in v1?
- What are the maximum per-run and monthly budgets, and who receives budget alerts?

## Non-goals for the first release

- Human messages after the opening trigger, autonomous tool use, or arbitrary web access.
- More than two active bots, branching conversations, or editing completed transcripts.
- A general-purpose social network or claims that frequency alone demonstrates sentiment,
  preference, factuality, or provider-wide behavior.
- Premature microservices, Kafka, a graph database, or a dedicated vector database.

## Development status

There is no runnable application yet. The M1 workspace scaffold supports format, lint,
typecheck, unit, integration, and build validation; application, database migration,
and browser checks will arrive in later vertical increments. Contributor and Codex
workflow rules live in [`AGENTS.md`](AGENTS.md).

## License

No license has been selected. Do not assume permission to redistribute or deploy this
code until the maintainers add one.
