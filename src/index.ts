import { Container, getContainer } from "@cloudflare/containers";
import { env as workerEnv } from "cloudflare:workers";

const PORT_READY_TIMEOUT_MS = 310_000;

type Env = {
  HINDSIGHT: DurableObjectNamespace<HindsightContainer>;

  // Secrets
  HINDSIGHT_API_DATABASE_URL: string;
  HINDSIGHT_API_MIGRATION_DATABASE_URL?: string;
  HINDSIGHT_API_LLM_API_KEY: string;
  HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY?: string;
  HINDSIGHT_API_RERANKER_COHERE_API_KEY?: string;

  // Optional edge-level protection if you are not using Cloudflare Access.
  HINDSIGHT_PROXY_BEARER?: string;
};

export class HindsightContainer extends Container {
  defaultPort = 8888;
  requiredPorts = [8888, 9999];
  sleepAfter = "30m";

  envVars = {
    HINDSIGHT_API_HOST: workerEnv.HINDSIGHT_API_HOST,
    HINDSIGHT_API_PORT: workerEnv.HINDSIGHT_API_PORT,
    HINDSIGHT_API_LOG_FORMAT: workerEnv.HINDSIGHT_API_LOG_FORMAT,

    HINDSIGHT_API_DATABASE_URL: workerEnv.HINDSIGHT_API_DATABASE_URL,
    HINDSIGHT_API_MIGRATION_DATABASE_URL:
      workerEnv.HINDSIGHT_API_MIGRATION_DATABASE_URL ?? "",

    HINDSIGHT_API_VECTOR_EXTENSION: workerEnv.HINDSIGHT_API_VECTOR_EXTENSION,
    HINDSIGHT_API_DB_POOL_MIN_SIZE: workerEnv.HINDSIGHT_API_DB_POOL_MIN_SIZE,
    HINDSIGHT_API_DB_POOL_MAX_SIZE: workerEnv.HINDSIGHT_API_DB_POOL_MAX_SIZE,

    HINDSIGHT_API_LLM_PROVIDER: workerEnv.HINDSIGHT_API_LLM_PROVIDER,
    HINDSIGHT_API_LLM_MODEL: workerEnv.HINDSIGHT_API_LLM_MODEL,
    HINDSIGHT_API_LLM_API_KEY: workerEnv.HINDSIGHT_API_LLM_API_KEY,

    HINDSIGHT_API_EMBEDDINGS_PROVIDER:
      workerEnv.HINDSIGHT_API_EMBEDDINGS_PROVIDER,
    HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL:
      workerEnv.HINDSIGHT_API_EMBEDDINGS_OPENROUTER_MODEL,
    HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY:
      workerEnv.HINDSIGHT_API_EMBEDDINGS_OPENROUTER_API_KEY ??
      workerEnv.HINDSIGHT_API_LLM_API_KEY,

    HINDSIGHT_API_RERANKER_PROVIDER: workerEnv.HINDSIGHT_API_RERANKER_PROVIDER,
    HINDSIGHT_API_RERANKER_OPENROUTER_MODEL:
      workerEnv.HINDSIGHT_API_RERANKER_OPENROUTER_MODEL,
    HINDSIGHT_API_RERANKER_OPENROUTER_API_KEY:
      workerEnv.HINDSIGHT_API_RERANKER_OPENROUTER_API_KEY ??
      workerEnv.HINDSIGHT_API_LLM_API_KEY,

    HINDSIGHT_API_LAZY_RERANKER: workerEnv.HINDSIGHT_API_LAZY_RERANKER,

    HINDSIGHT_CP_DATAPLANE_API_URL: workerEnv.HINDSIGHT_CP_DATAPLANE_API_URL,
  };

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Public API / MCP / OpenAPI routes go to Hindsight API on 8888.
    const apiPrefixes = [
      "/v1",
      "/mcp",
      "/docs",
      "/redoc",
      "/openapi.json",
      "/health",
      "/metrics",
    ];

    if (apiPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      await this.startAndWaitForPorts(8888, {
        abort: request.signal,
        portReadyTimeoutMS: PORT_READY_TIMEOUT_MS,
      });

      return this.containerFetch(request, 8888);
    }

    // The image starts the Control Plane after the API is healthy, so an API
    // request can mark the container healthy before port 9999 is ready.
    await this.startAndWaitForPorts(9999, {
      abort: request.signal,
      portReadyTimeoutMS: PORT_READY_TIMEOUT_MS,
    });

    // Everything else goes to the Control Plane UI on 9999.
    return this.containerFetch(request, 9999);
  }
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Bearer realm="hindsight"',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Prefer Cloudflare Access for browser UI protection.
    // This optional bearer check is useful for API-only deployments.
    if (env.HINDSIGHT_PROXY_BEARER) {
      const expected = `Bearer ${env.HINDSIGHT_PROXY_BEARER}`;
      if (request.headers.get("Authorization") !== expected) {
        return unauthorized();
      }
    }

    // Fixed instance name = one Hindsight app instance.
    // Start here before trying horizontal scaling.
    const container = getContainer(env.HINDSIGHT, "primary");
    return container.fetch(request);
  },
};
