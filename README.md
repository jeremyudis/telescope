# telescope

AI-powered observability and telemetry reviewer for GitHub pull requests. Built on Cloudflare Workers + Agents SDK.

Telescope reads your PR diffs and project dependencies, then generates actionable recommendations for improving telemetry coverage — metrics, logging, tracing, error tracking, and more.

## How it works

Telescope uses a two-stage LLM pipeline to efficiently process PRs of any size:

**Stage 1 — Triage**: A lightweight model assesses each changed file's observability relevance in parallel. Files are scored 0-10 and sorted. Pure UI, docs, and config changes are filtered out.

**Stage 2 — Analysis**: A full-capability model receives curated context — dependency manifests, triage summaries, and raw diffs only for high-relevance files — and produces structured recommendations.

### Dependency-aware

Telescope fetches your project's dependency manifest (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc.) and passes it to the model. Recommendations stay consistent with your existing telemetry stack — if you use Prometheus, it suggests Prometheus patterns, not Datadog.

## What it flags

| Category | Severity | Examples |
|----------|----------|---------|
| `missing-telemetry` | warning | HTTP handlers without tracing, uninstrumented DB queries, swallowed errors |
| `high-cardinality` | critical | User IDs as metric labels, unbounded tag values, dynamic metric names |
| `instrumentation` | info | Suggesting OTel auto-instrumentation, dd-trace integrations, structured logging libs |
| `logging` | warning | `console.log` instead of structured logging, PII in log messages, missing correlation IDs |
| `error-tracking` | warning | Silently caught exceptions, error responses without logging |
| `naming` | info | Non-standard metric names, missing units, generic span names |
| `best-practice` | info | Missing SLI metrics, broken trace context propagation |

## Setup

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free plan works)
- [Node.js](https://nodejs.org/) 18+
- A GitHub personal access token with `repo` scope

### Install

```bash
git clone https://github.com/jeremyudis/telescope.git
cd telescope
npm install
```

### Configure secrets

```bash
# Authenticate with Cloudflare
npx wrangler login

# Set your GitHub token
npx wrangler secret put GITHUB_TOKEN
```

For local development, create a `.dev.vars` file:

```
GITHUB_TOKEN=ghp_your_token_here
```

### Run locally

```bash
npm run dev
```

### Deploy

```bash
npm run deploy
```

## Usage

### Review a PR

```bash
curl -X POST http://localhost:8787/review \
  -H 'Content-Type: application/json' \
  -d '{"owner": "your-org", "repo": "your-repo", "pullNumber": 123}'
```

Returns a JSON `ReviewResult` with structured recommendations.

### Review and post a comment

```bash
curl -X POST http://localhost:8787/review-and-comment \
  -H 'Content-Type: application/json' \
  -d '{"owner": "your-org", "repo": "your-repo", "pullNumber": 123}'
```

Same as above, but also posts a formatted markdown summary as a comment on the PR.

### GitHub webhook

Set up a webhook pointing to `https://your-worker.workers.dev/webhook` with the `pull_request` event. Telescope will automatically review new and updated PRs.

## Architecture

```
telescope/
├── src/
│   ├── index.ts        # Worker entry point, HTTP routing
│   ├── agent.ts        # TelescopeAgent (Durable Object with persistent state)
│   ├── triage.ts       # Stage 1: parallel per-file relevance scoring
│   ├── analysis.ts     # Stage 2: curated context assembly + LLM analysis
│   ├── prompts.ts      # System prompts for triage and analysis
│   ├── model.ts        # Model provider abstraction (Workers AI / Anthropic)
│   ├── github.ts       # GitHub REST API client
│   ├── schemas.ts      # Zod schemas for structured LLM output
│   └── types.ts        # TypeScript interfaces
├── wrangler.toml       # Cloudflare Workers config
└── env.d.ts            # Environment type definitions
```

## Model providers

**Default: Cloudflare Workers AI** (free, no API key needed)
- Triage: `@cf/meta/llama-3.2-3b-instruct`
- Analysis: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

**Anthropic Claude** (faster, higher quality):
1. `npm install @ai-sdk/anthropic`
2. Update `src/model.ts` (see comments in file)
3. Set secrets:
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
4. Add `MODEL_PROVIDER=anthropic` to your `wrangler.toml` `[vars]` section

## License

ISC
