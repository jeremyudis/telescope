# telescope: PR Telemetry & Observability Review Agent

## Context

Build a Cloudflare Workers agent that reviews GitHub pull requests and makes broad telemetry and observability recommendations — covering metrics, logging, tracing, profiling, error tracking, and alerting across any tech stack. Not limited to OpenTelemetry; covers Datadog, Prometheus, StatsD, structured logging libraries, APM agents, custom instrumentation, and more.

## Key Design Decisions

1. **Architecture**: Cloudflare Workers + Agents SDK with Durable Objects (available on free plan as of April 2025, SQLite-backed). Gives us persistent review history, per-repo state, and a clean `Agent` class structure from day one.

2. **Trigger**: HTTP `POST /review` endpoint (test with `curl`). GitHub webhook on `pull_request.opened`/`synchronize` for automated reviews.

3. **Telemetry knowledge**: Lives in the system prompt (~4-5K tokens). Covers the full observability spectrum.

4. **Model**: Default is **Cloudflare Workers AI** (no API key needed, built-in binding). Model abstracted behind a provider function so swapping to Anthropic Claude is a config change.
   - Triage: `@cf/meta/llama-3.2-3b-instruct` (fast, parallel-friendly)
   - Analysis: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (function calling support, needed for structured output)

5. **Two-stage LLM pipeline for context management**: Raw diffs are noisy and large PRs can blow context windows. Instead of dumping everything into one call:
   - **Stage 1 (Triage)**: Cheap/fast model processes each file's diff individually in parallel. Per file, it outputs a short summary (~100-200 tokens): "Is this file observability-relevant? What changed and why does it matter for telemetry?" Files with no observability implications are filtered out entirely. Uses `generateText` with manual JSON parsing (the 3B model does not support JSON schema/function calling).
   - **Stage 2 (Analysis)**: Full model receives the curated context: dependency manifests + triage summaries for all relevant files + raw diff only for the top N highest-relevance files (where line-specific suggestions are needed). Uses `generateObject` with Zod schemas for structured output (the 70B model supports function calling).
   - A 500-file PR becomes: 500 cheap parallel triage calls → one focused analysis call with ~20 raw diffs + ~80 one-line summaries.

6. **Dependency-aware recommendations**: Fetch the repo's dependency manifest(s) and pass raw content to the LLM. No custom parsing — the model identifies the existing telemetry stack and tailors recommendations accordingly.

7. **GitHub API**: Raw `fetch` — no Octokit. Octokit has known compatibility issues with the Cloudflare Workers edge runtime (crypto polyfills, deployment failures). Our API surface is small enough that raw fetch is simpler and more reliable.

## Project Structure

```
telescope/
├── src/
│   ├── index.ts        # Worker entry point, HTTP routing
│   ├── agent.ts        # TelescopeAgent (Durable Object with persistent state)
│   ├── github.ts       # GitHub REST API client (fetch diff, deps, post comments)
│   ├── triage.ts       # Stage 1: per-file triage (parallel, cheap model)
│   ├── analysis.ts     # Stage 2: full analysis (curated context, full model)
│   ├── prompts.ts      # System prompts for both stages
│   ├── model.ts        # Model provider abstraction (Workers AI / Anthropic)
│   ├── schemas.ts      # Zod schemas for structured LLM output
│   └── types.ts        # Shared TypeScript types
├── specs/
│   └── design.md       # This file
├── wrangler.toml       # Cloudflare Workers config
├── env.d.ts            # Environment type definitions
├── tsconfig.json
└── package.json
```

## Implementation Details

### Types & Schemas (`types.ts`, `schemas.ts`)
- `ReviewRequest`: `{ owner, repo, pullNumber }`
- `FileChange`: `{ filename, status, additions, deletions, patch, language }`
- `TriageResult`: `{ filename, relevant, relevanceScore, summary }`
- `Recommendation`: `{ file, line?, category, severity, title, description, suggestion? }`
  - Categories: `missing-telemetry | high-cardinality | instrumentation | logging | error-tracking | naming | best-practice`
  - Severities: `info | warning | critical`
- `ReviewResult`: `{ recommendations[], summary, filesAnalyzed, filesTriaged, filesSkipped }`
- Zod schemas for the analysis stage's structured output via `generateObject`

### Model Provider Abstraction (`model.ts`)
- `getModel(env, tier: "triage" | "analysis")` — returns appropriate model per stage
- Default: Workers AI (no API key)
- Anthropic: install `@ai-sdk/anthropic`, set `MODEL_PROVIDER=anthropic` env var
  - Triage: Claude Haiku (cheap, fast)
  - Analysis: Claude Sonnet (strong reasoning)

### GitHub Client (`github.ts`)
- `fetchPRFiles` → paginated file list with patches, filtering out lockfiles/generated code/images
- `fetchPRMetadata` → title, description, base/head refs
- `fetchFileContent` → raw file content by path and ref
- `fetchDependencyManifests` → tries known manifest paths (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`, `Gemfile`, etc.), returns raw content
- `postReviewComment` → posts markdown comment on the PR
- All via native `fetch` with `Authorization: Bearer ${token}` header

### Stage 1 — Triage (`triage.ts`)
- Processes files in batches of 5 (avoids overwhelming Workers AI)
- Per-file diffs truncated to 3000 chars (keeps triage prompts small for the 3B model)
- Uses `generateText` + manual JSON parsing (3B model lacks function calling)
- On failure: file gets score 5 and is included for safety (never silently dropped)
- Results sorted by relevance score descending

### Stage 2 — Analysis (`analysis.ts`)
- Context assembly:
  - Raw dependency manifests (passed as-is for the LLM to interpret)
  - PR metadata (title, description, branch)
  - Files with `relevanceScore >= 7`: full raw diff included
  - Files with `relevanceScore >= 3 && < 7`: triage summary only
  - Files with `relevanceScore < 3`: omitted entirely
  - Token budget: ~80K tokens for diff context, with truncation fallback
- Uses `generateObject` with Zod schema for structured output
- `formatReviewComment`: renders markdown grouped by severity with tables

### Agent Class (`agent.ts`)
- `TelescopeAgent extends Agent<Env, TelescopeState>`
- `@callable() reviewPR(request)`: full pipeline — fetch → triage → analyze → persist
- `@callable() reviewAndComment(request)`: reviewPR + post comment to GitHub
- `onStart()`: creates `reviews` SQLite table
- State: `lastReview` and `reviewCount`
- Durable Object instances named by `owner/repo` for per-repo history

### Worker Entry Point (`index.ts`)
- `POST /review` → JSON review result
- `POST /review-and-comment` → JSON result + posts PR comment
- `POST /webhook` → GitHub webhook handler (fire-and-forget via `ctx.waitUntil`)
- `GET /` → health check
- Fallback: `routeAgentRequest()` for agent framework WebSocket/RPC routing
- Uses `getAgentByName` from agents SDK for typed Durable Object RPC

## System Prompts (`prompts.ts`)

### Triage Prompt
Assesses per-file observability relevance on a 0-10 scale:
- 0: Pure UI/styling, docs, config
- 1-3: Near telemetry code but not directly modifying it
- 4-6: New endpoints, DB queries, error handling (may need instrumentation)
- 7-10: Direct metric/logging/tracing changes, cardinality-impacting changes

### Analysis Prompt
Covers the full observability spectrum:
- **Missing telemetry**: Uninstrumented HTTP handlers, DB queries, error paths, background jobs, external calls
- **High cardinality** (always critical): Unbounded metric labels, dynamic metric names, high-cardinality log templates
- **Instrumentation**: Stack-consistent library suggestions (OTel, Datadog, Prometheus, etc.)
- **Logging**: Structured logging, appropriate levels, PII detection, correlation IDs
- **Error tracking**: Swallowed exceptions, missing breadcrumbs
- **Naming**: Metric naming conventions, units, histogram buckets, span naming
- **Best practices**: SLI metrics, trace context propagation, sampling

Core instruction: "Recommend improvements consistent with the existing stack. Do not recommend switching stacks."

## Verification

1. `npx wrangler dev` starts without errors
2. `curl /review` with a known PR returns relevant, correctly-categorized recommendations
3. Triage correctly scores files (CSS/docs → 0, HTTP handler → 8+, metrics code → 10)
4. Analysis receives only relevant context — no noise from irrelevant files
5. Recommendations respect the existing telemetry stack
6. Large PR (100+ files) — parallel triage completes, context budget respected
7. `/review-and-comment` posts readable markdown to the PR
8. PRs in different languages get language-appropriate suggestions

## Post-MVP Enhancements
- Inline review comments on specific diff lines (GitHub pending review API)
- Webhook signature validation (`X-Hub-Signature-256`)
- Chat mode via `AIChatAgent` for interactive refinement
- Per-repo custom rules stored in agent state
- Review history dashboard querying SQLite
- GitHub App for org-wide deployment
- Monorepo support: detect per-package dependency manifests
- Triage caching: skip re-triaging files that haven't changed between PR updates
