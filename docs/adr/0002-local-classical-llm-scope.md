# 0002 — Local classical LLM scope

- **Status:** accepted
- **Date:** 2026-09-10
- **Owners:** repository maintainers
- **Supersedes:** none

## Context

The first runnable increment needs a narrow product boundary before API and worker code
are added. A general agent harness would introduce planning, memory, tools, retrieval,
and execution risks that are not needed to study alternating model dialogue. Language
support and system-prompt visibility also affect contracts, fixtures, moderation, and
future user interfaces.

## Decision

The current product is a local-only application. It has no public deployment,
multi-tenant access, or remote session creation surface.

The initial supported conversation and analysis language is English. Canonical model
output still preserves all Unicode text exactly, but non-English analysis quality is not
promised and unsupported-language sessions must not be silently included in English
metrics. Broader language support requires versioned fixtures and explicit quality gates.

System prompts are public research provenance for every session that references them.
They are not secret configuration. The eventual local API and UI may expose them with
the immutable bot version, and fixtures and operators must never place credentials,
personal data, or confidential instructions in a system prompt.

Bots use classical LLM next-token generation over the ordered message context. The
orchestrator calls the provider adapter directly. There is no agent harness, autonomous
planning loop, tool or function calling, retrieval, code execution, browser access,
persistent bot memory, or model-initiated side effect. Two bots still alternate under
the deterministic domain state machine and explicit run limits.

## Alternatives considered

- A general-purpose agent framework was rejected because it adds nondeterministic loops,
  side effects, and a much larger security and provenance surface without serving the
  first research questions.
- Multilingual v1 analysis was deferred because each supported language needs reviewed
  tokenization rules, fixtures, moderation expectations, and slice-level benchmarks.
- Confidential system prompts were rejected for the local research scope because hidden
  prompts would make sessions harder to interpret and reproduce.
- A public or hosted application was deferred until identity, quotas, publication,
  retention, deletion, moderation, region, and budget decisions are accepted.

## Consequences

Provider contracts remain limited to messages and bounded completion parameters. No
tool schema or agent-runtime abstraction should be introduced. Tests use the
deterministic fake completion provider, and a real provider must pass the same
tool-free contract suite before integration.

English fixtures and analysis can ship first, while canonical storage remains capable
of preserving other scripts for later reprocessing. Interfaces must label the supported
analysis language rather than implying multilingual quality. Public prompts improve
provenance but prevent prompt secrecy from being used as a product assumption.

## Security, privacy, and cost

Removing tools, retrieval, autonomous loops, and remote access sharply limits prompt
injection impact and unbounded external side effects. Model output remains untrusted and
must never be executed or rendered as HTML. Public system prompts require pre-save
validation and contributor guidance against secrets or personal data. Existing message,
token, duration, and integer-microunit cost ceilings remain mandatory even locally.

Local-only is not permission to use production credentials or unapproved transcript
data. Provider secrets stay in environment injection and are never prompt content or
persisted provenance.

## Rollout and rollback

Apply this boundary to the first API, worker, provider, and analysis implementations.
No schema migration is required. Expanding to hosted access, another analysis language,
confidential prompts, tools, retrieval, memory, or an agent harness requires a new ADR
with contracts, threat analysis, limits, tests, and a rollback plan. Existing sessions
must retain the scope and capability provenance under which they ran.
