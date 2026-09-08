# Agora Bots milestones

- **Status:** proposed
- **Last updated:** 2026-09-08

This roadmap treats Agora Bots as both a public interactive product and potential
research infrastructure. The order is deliberate: provenance, corpus integrity, and
measurement definitions come before persuasive dashboards or claims about model
behavior.

Dates are intentionally omitted until maintainers decide staffing, provider access,
deployment region, review obligations, and budget. Milestones use evidence-based exit
criteria instead of calendar promises. Each milestone should become a tracked issue or
epic with an owner, target date, risks, and links to its implementation pull requests.

## Milestone overview

| ID | Milestone | Primary outcome | Depends on |
| --- | --- | --- | --- |
| M0 | Research charter and governance | The questions, claims, ethics, and data policy are explicit. | — |
| M1 | Reproducible foundation | One command validates a strict, observable local stack. | M0 |
| M2 | Durable two-bot runner | Bounded conversations survive retries and worker restarts. | M1 |
| M3 | Corpus and provenance release 0 | Every session can be interpreted as a versioned research observation. | M2 |
| M4 | Lexical index and audit benchmark | Words and *k*-word passages are correctly searchable and traceable. | M3 |
| M5 | Cross-conversation explorer | Visitors navigate evidence across bots and sessions. | M4 |
| M6 | Semantic similarity | Versioned embeddings expose auditable behavioral similarities. | M4 |
| M7 | Comparative research dashboard | Cohort comparisons report denominators, uncertainty, and confounders. | M5, M6 |
| M8 | Public beta and optional replay | The service is safe, accessible, understandable, and operable. | M7 |
| M9 | Citable research release | A frozen corpus and pipeline can be independently reproduced. | M8 |

M5 and M6 can be developed in parallel after M4. M8's recorded-conversation replay is
optional and must not delay research-quality search or accessibility.

## M0 — Research charter and governance

### Deliverables

- Define a small set of primary research questions and distinguish exploratory analyses
  from confirmatory hypotheses. Pre-register confirmatory hypotheses before collecting
  the corresponding corpus.
- Publish operational definitions for “mention,” “topic,” “brand,” “preference,”
  “similar behavior,” and the unit of analysis (occurrence, message, session, or run).
- Document known confounders: scenario wording, turn order, model/provider changes,
  system prompts, sampling parameters, language, transcript length, date, safety layers,
  outages, and unequal run completion.
- Decide public/private defaults, consent and acceptable-use terms, licensing, retention,
  deletion, moderation, researcher access, and whether institutional ethics/IRB review
  is required. Record the decision and rationale; do not assume that “bots only” means
  there are no human-subject, copyright, or privacy concerns.
- Define spending ceilings, provider/data residency constraints, incident ownership, and
  criteria for suspending collection when a provider changes behavior or metadata.
- Create ADRs for event persistence, authentication, deployment, content policy, and
  corpus versioning.

### Exit criteria

- The charter, data-management plan, statistical analysis outline, threat model, and
  decision log have named maintainers and completed review.
- Each intended public claim maps to a metric, denominator, comparison cohort, known
  limitations, and source evidence. Unsupported “preference” claims are out of scope.

## M1 — Reproducible foundation

### Deliverables

- Scaffold the pnpm/TypeScript workspace and documented module boundaries.
- Provide pinned local PostgreSQL and Redis services, migrations, validated configuration,
  structured logs, trace correlation, CI, dependency scanning, and secret scanning.
- Add a deterministic fake provider, fixed clock/ID seams, representative Unicode test
  fixtures, and standard format/lint/typecheck/unit/integration/build commands.
- Establish ADR, event-schema, dataset-schema, and analysis-version conventions.

### Exit criteria

- A clean checkout can run the documented checks and local stack without paid APIs.
- CI produces the same deterministic fake-provider transcript and records tool/runtime
  versions; no fixture contains credentials or unapproved transcript data.

## M2 — Durable two-bot runner

### Deliverables

- Implement immutable bot/scenario versions, sessions, participants, append-only events,
  projections, transactional outbox delivery, leases, and explicit state transitions.
- Alternate exactly two bot participants after the human-selected opening message.
- Enforce message, total-token, duration, and cost ceilings before and after calls.
- Stream durable sequence-numbered SSE events; support resume, cancellation, retry,
  provider errors, partial output, and worker crash recovery.
- Add one real provider only after its adapter passes the fake provider's contract suite.

### Exit criteria

- End-to-end tests create, watch, stop, reload, and resume a session.
- Fault-injection tests demonstrate no duplicate committed turn after job redelivery,
  ambiguous failures, or worker restart, and every terminal session has a stop reason.
- Stored provenance includes exact bot/scenario versions, prompts, parameters, provider
  model identifiers, normalized usage, timestamps, and finish reasons without secrets.

## M3 — Corpus and provenance release 0

### Deliverables

- Define a versioned corpus manifest containing session IDs, inclusion/exclusion reasons,
  collection windows, scenarios, bot/model versions, parameters, pipeline versions,
  checksums, and completeness flags.
- Detect and surface model alias/version drift, truncated sessions, missing usage, retries,
  moderation exclusions, and provider incidents instead of silently pooling them.
- Separate immutable raw observations from rebuildable transcript and analysis
  projections. Implement retention and deletion propagation with an audit trail.
- Define train/validation/evaluation or exploratory/confirmatory partitions where the
  research design needs them; prevent dashboard tuning against a held-out corpus.

### Exit criteria

- A corpus snapshot can be regenerated from canonical events and produces matching
  checksums and inclusion counts.
- A data-quality report accounts for every attempted session and quantifies missing,
  excluded, failed, and partial observations by cohort.

## M4 — Lexical index and audit benchmark

### Deliverables

- Implement language-tagged, versioned tokenization and one positional occurrence per
  searchable word with canonical Unicode offsets.
- Build overlapping sentence-aware *k*-word passages (initial proposal: 20 words,
  10-word stride), exact/phrase search, reviewed dictionaries and aliases, and stable
  transcript-span links.
- Publish a multilingual gold fixture set covering punctuation, emoji, normalization,
  combining characters, right-to-left text, contractions, hyphenation, and sentence
  boundaries.
- Define separate quality metrics for token boundaries, source offsets, exact retrieval,
  dictionary entity resolution, ranking, and indexing latency.

### Exit criteria

- Every benchmark result round-trips to the exact canonical substring; reconstructed
  chunks/messages match canonical text byte-for-byte where applicable.
- Recall/precision thresholds are written before benchmark evaluation and met on the
  held-out fixtures. Failures remain visible by language rather than being averaged away.
- Rebuilding an index version is idempotent, visibility-safe, and leaves the prior
  version available until cutover.

## M5 — Cross-conversation explorer

### Deliverables

- Support query-box and click-to-explore navigation from a word, phrase, entity, bot,
  chart, or passage to matching sessions and exact highlighted spans.
- Show occurrence count, message/session coverage, denominator word count, rate per
  1,000 words, neighboring terms, defined-window co-occurrence, representative examples,
  and cohort/time filters.
- Preserve queries, filters, metric definitions, index versions, and focused spans in
  shareable URLs and exports.
- Keep exact matches, dictionary/alias matches, and future semantic matches visibly
  distinct. Every aggregate and chart supports authorized source drill-down.

### Exit criteria

- Browser tests cover transcript → selected word → cohort statistic → source example →
  related term navigation, including reload and shared-link recovery.
- Accessibility review covers keyboard-only selection, screen readers, contrast, focus,
  responsive layouts, and reduced motion.
- Usability participants can correctly explain the difference between mentions, session
  coverage, normalized frequency, co-occurrence, and preference.

## M6 — Semantic similarity

### Deliverables

- Embed versioned *k*-word passages with stored model, dimensions, preprocessing version,
  canonical offsets, and job provenance.
- Provide nearest passages with similarity/distance, bot/session/scenario filters, source
  links, and explicit “semantic” labeling separate from lexical frequencies.
- Construct an evaluation set with independent relevance judgments, hard negatives,
  duplicate controls, and language/cohort slices. Record annotator instructions and
  inter-rater agreement where humans judge relevance.
- Benchmark retrieval quality, stability between embedding versions, latency, storage,
  and cost. Prevent private/deleted data from affecting visible results.

### Exit criteria

- Predeclared retrieval metrics meet their target on held-out judgments, with slice-level
  results and limitations published.
- An embedding-version migration can run alongside the prior version, compare results,
  switch atomically, and roll back without changing canonical observations.

## M7 — Comparative research dashboard

### Deliverables

- Define bot/model/scenario/time cohorts from immutable version identifiers and display
  sample sizes, denominators, collection dates, missingness, and pipeline versions.
- Report effect sizes and uncertainty intervals, not only ranks or point estimates.
  Apply multiple-comparison controls when exploring many terms or cohorts.
- Add stratification or models for predeclared confounders, sensitivity analyses, and
  warnings where sample size or overlap is insufficient.
- Provide downloadable tidy data, machine-readable metric definitions, query manifests,
  source drill-down, and a reproducible script/notebook for headline figures.
- Clearly distinguish descriptive, exploratory, and confirmatory results. Do not equate
  lexical frequency, sentiment, or semantic proximity with endorsement or intent.

### Exit criteria

- An independent reviewer can recreate every headline figure from a frozen corpus
  manifest and exported analysis configuration.
- Statistical and domain reviewers approve metric definitions, uncertainty treatment,
  confounder handling, limitations, and wording of public claims.

## M8 — Public beta and optional replay

### Deliverables

- Add roles, quotas, moderation/publication workflow, abuse prevention, kill switches,
  budget alerts, backups/restore drills, deletion, incident response, and service-level
  indicators for run success, stream recovery, indexing lag, and analysis freshness.
- Complete security, privacy, accessibility, load, cost, and disaster-recovery reviews.
- Publish a methodology page, data statement/model cards, change log, known limitations,
  issue-reporting path, and conspicuous version/date labels.
- If usability evidence supports it, offer recorded playback as an optional, clearly
  labeled “Replay” with pause, speed, full-transcript, instant deep-link reveal, and
  reduced-motion behavior. Never imply stored generation is live.

### Exit criteria

- A limited cohort completes the primary run/watch/search/compare flows within approved
  error, latency, accessibility, moderation, and budget thresholds.
- Restore, provider-outage, budget-exhaustion, deletion, and incident-response exercises
  pass. Playback ships only if it improves predefined comprehension/usability measures.

## M9 — Citable research release

### Deliverables

- Freeze a versioned corpus and analysis release with checksums, schema documentation,
  code commit, environment lockfiles/container digest, prompts/scenarios where disclosure
  is permitted, inclusion flow, and all pipeline/model versions.
- Publish a data statement, methods, ethics/privacy assessment, limitations, changelog,
  citation metadata, and an archival identifier such as a DOI when governance and
  licensing permit distribution.
- Supply a minimal reproduction package that rebuilds published tables/figures from the
  permitted snapshot. If raw text cannot be distributed, document an audited access or
  verification procedure and clearly state what cannot be independently reproduced.
- Establish errata, retraction, takedown, version-support, and long-term preservation
  policies. Never mutate an already cited release; publish a successor.

### Exit criteria

- A researcher who was not involved in implementation follows the documentation in a
  clean environment and reproduces the declared artifacts within stated tolerances.
- Release review confirms provenance completeness, license compatibility, deletion and
  consent obligations, statistical reporting, security, and archival durability.

## Cross-cutting gates for every milestone

Each milestone review records:

- **Evidence:** exact commands, test reports, benchmark manifests, screenshots where
  applicable, and links to source data/code versions.
- **Research integrity:** hypotheses or exploratory labels, analysis version, corpus
  version, denominators, exclusions, missingness, confounders, uncertainty, and limits on
  interpretation.
- **Traceability:** every presented example or aggregate can resolve to authorized
  canonical transcript spans and immutable bot/scenario/model provenance.
- **Safety and governance:** privacy, deletion, moderation, provider terms, threat model,
  licensing, accessibility, and human review impacts.
- **Operations and cost:** bounded workloads, measured spend/storage, rate limits,
  observability, recovery, rollout, and rollback.
- **Change control:** accepted ADRs for durable decisions and explicit migration paths for
  schemas, events, indexes, embeddings, dictionaries, and published datasets.

Passing a software test is necessary but not sufficient for a research milestone. A
milestone remains open when its scientific validity, provenance, governance, or
independent reproducibility gate is unmet.
