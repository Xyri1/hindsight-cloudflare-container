# Deploy Hindsight on Cloudflare Containers

This repository runs the Hindsight API and Control Plane inside a single Cloudflare Container, fronted by a Worker and a Durable Object. The Worker keeps one named container instance alive, forwards API traffic to the Hindsight API on port `8888`, and forwards everything else to the Control Plane UI on port `9999`.

## What this project deploys

- A Cloudflare Worker that routes requests into a container instance.
- A single Cloudflare Container instance named `primary`.
- Hindsight API on port `8888`.
- Hindsight Control Plane UI on port `9999`.
- Optional bearer-token protection at the Worker edge via `HINDSIGHT_PROXY_BEARER`.

## Architecture

```text
Client
	|
	v
Cloudflare Worker
	|
	+-- /v1, /mcp, /docs, /redoc, /openapi.json, /health, /metrics -> Hindsight API :8888
	|
	+-- everything else -> Control Plane UI :9999
	|
	v
Cloudflare Container (class: HindsightContainer)
```

The container image comes from [Dockerfile](./Dockerfile) and is based on `ghcr.io/vectorize-io/hindsight:latest-slim`.

## Prerequisites

- Node.js 20+ and npm.
- A Cloudflare account with Workers Paid plan access, because Cloudflare Containers require a paid Workers plan.
- Wrangler authenticated against the target Cloudflare account.
- A Postgres database for Hindsight. Neon is a good fit here.
- An LLM provider key. The default config expects OpenRouter-compatible models.

## Configuration model

Two layers of configuration are used:

- Non-secret defaults live in [wrangler.jsonc](./wrangler.jsonc).
- Secrets live in `.dev.vars` for local development and in Cloudflare secrets or a deploy-time secrets file for production.

### Default runtime settings

This repo already sets these sensible defaults in [wrangler.jsonc](./wrangler.jsonc):

- JSON logs
- `pgvector` as the vector extension
- conservative database pool sizes
- OpenRouter as the default LLM, embeddings, and reranker provider
- `openai/gpt-5.4-nano` as the default chat model
- `openai/text-embedding-3-small` as the default embeddings model
- `cohere/rerank-4-pro` as the default reranker model
- lazy reranker startup enabled

### Required secrets

Copy `.dev.vars.example` to `.dev.vars` for local development and fill in the values:

```bash
cp .dev.vars.example .dev.vars
```

Required keys:

- `HINDSIGHT_API_DATABASE_URL`: pooled runtime database URL.
- `HINDSIGHT_API_MIGRATION_DATABASE_URL`: direct database URL for migrations and admin-style operations.
- `HINDSIGHT_API_LLM_API_KEY`: API key for the configured LLM provider.
- `HINDSIGHT_PROXY_BEARER`: optional shared bearer token enforced by the Worker.

Optional overrides:

- `HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY`: overrides the embeddings provider key. If unset, the app falls back to `HINDSIGHT_API_LLM_API_KEY`.
- `HINDSIGHT_API_RERANKER_OPENROUTER_API_KEY`: overrides the reranker provider key. If unset, the app falls back to `HINDSIGHT_API_LLM_API_KEY`.

### Database guidance

For Neon:

- Use a pooled connection string for `HINDSIGHT_API_DATABASE_URL`.
- Use a direct connection string for `HINDSIGHT_API_MIGRATION_DATABASE_URL`.

That split matters because pooled connections are the right default for serverless request traffic, while migrations and admin tasks often need direct connections.

## Local development

Install dependencies:

```bash
npm install
```

Create `.dev.vars` from the example file:

```bash
cp .dev.vars.example .dev.vars
```

Start the Worker and local container runtime:

```bash
npm run dev
```

Wrangler will read `.dev.vars` during local development.

### Local verification

If you set `HINDSIGHT_PROXY_BEARER`, include it in requests:

```bash
curl -i \
	-H "Authorization: Bearer $HINDSIGHT_PROXY_BEARER" \
	http://127.0.0.1:8787/health
```

Useful routes:

- `GET /health`: health check
- `GET /docs`: API docs
- `GET /openapi.json`: OpenAPI spec
- `GET /`: Control Plane UI

## Production deployment

### Option 1: deploy with a secrets file

Create an `.env.production` file with the same keys as `.dev.vars.example`, then deploy with:

```bash
npm run deploy:prod
```

### Option 2: manage secrets in Cloudflare and deploy normally

Set the required secrets in Cloudflare, then deploy with:

```bash
npm run deploy
```

### Inspect container state

List provisioned containers:

```bash
npm run containers:list
```

List uploaded images:

```bash
npm run containers:images
```

### Verify deployment

Run the deployment smoke test against the deployed Worker URL:

```bash
npm run test:deployment -- https://hindsight-cloudflare-container.<account>.workers.dev
```

Or set the URL in the environment:

```bash
HINDSIGHT_DEPLOYMENT_URL=https://hindsight-cloudflare-container.<account>.workers.dev npm run test:deployment
```

If `HINDSIGHT_PROXY_BEARER` is enabled for the deployment, export the same value before running the test or keep it in `.env.production`; the script loads that file automatically when present. The script verifies `/health`, `/openapi.json`, `/docs`, and `/`.

## Routing behavior

The Worker routes these prefixes to the Hindsight API on port `8888`:

- `/v1`
- `/mcp`
- `/docs`
- `/redoc`
- `/openapi.json`
- `/health`
- `/metrics`

Everything else is forwarded to the Control Plane UI on port `9999`.

## Security notes

- `HINDSIGHT_PROXY_BEARER` protects every request at the Worker edge. If you enable it, all routes require `Authorization: Bearer <token>`.
- For browser-facing deployments, Cloudflare Access is the stronger option. The bearer token is mainly useful for API-only or narrowly scoped private deployments.
- Do not commit `.dev.vars`, `.env.production`, database URLs, or provider API keys.

## Model and vector compatibility

- The default vector extension in this repo is `pgvector`, so the embeddings model must stay at 2000 dimensions or less.
- `openai/text-embedding-3-small` works with the current defaults.

## Files worth knowing

- [src/index.ts](./src/index.ts): Worker, Container class, routing, and bearer auth.
- [wrangler.jsonc](./wrangler.jsonc): Worker and container configuration plus non-secret defaults.
- [Dockerfile](./Dockerfile): base Hindsight image.
- [.dev.vars.example](./.dev.vars.example): required local secrets.

## Next steps

Once deployed, the first checks should be:

1. Hit `/health` and confirm the API starts.
2. Open `/docs` and confirm the OpenAPI routes are reachable.
3. Open `/` and confirm the Control Plane UI loads.
4. Verify the runtime database URL is pooled and the migration URL is direct.
