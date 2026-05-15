#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

function readProductionEnv() {
  if (!existsSync(".env.production")) {
    return {};
  }

  return Object.fromEntries(
    readFileSync(".env.production", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.replace(/^export\s+/, ""))
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();

        return [key, value.replace(/^(['"])(.*)\1$/, "$2")];
      }),
  );
}

function fail(message) {
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) {
    fail(message);
  }
}

async function readJson(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    fail(`Expected JSON response from ${response.url}, received: ${text}`);
  }
}

async function requestJson(baseUrl, path, { bearer, method = "GET", body } = {}) {
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await readJson(response);

  if (!response.ok) {
    fail(`${method} ${path} -> ${response.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

function resultText(result) {
  return [
    result.text,
    result.context,
    ...(Array.isArray(result.entities) ? result.entities : []),
  ]
    .filter((value) => typeof value === "string")
    .join("\n");
}

const productionEnv = readProductionEnv();
const target =
  process.argv[2] ??
  process.env.HINDSIGHT_DEPLOYMENT_URL ??
  productionEnv.HINDSIGHT_DEPLOYMENT_URL;
const bearer =
  process.env.HINDSIGHT_PROXY_BEARER ?? productionEnv.HINDSIGHT_PROXY_BEARER;

if (!target) {
  console.error(
    "Usage: npm run test:lifecycle -- https://your-worker.example.workers.dev",
  );
  console.error(
    "You can also set HINDSIGHT_DEPLOYMENT_URL instead of passing a URL.",
  );
  process.exit(1);
}

let baseUrl;

try {
  baseUrl = new URL(target);
} catch {
  console.error(`Invalid deployment URL: ${target}`);
  process.exit(1);
}

const unique = Date.now().toString(36);
const bankId = `codex-lifecycle-${unique}`;
const retainedFact = `Codex lifecycle smoke marker ${unique} uses heliotrope ledger protocol.`;

let bankCreated = false;

try {
  const created = await requestJson(baseUrl, `/v1/default/banks/${bankId}`, {
    bearer,
    method: "PUT",
    body: {
      name: "Codex Lifecycle Smoke Bank",
      reflect_mission:
        "Recall exact facts retained during an automated lifecycle smoke test.",
      retain_mission:
        "Extract concise factual memories from lifecycle smoke test content.",
    },
  });
  bankCreated = true;
  expect(created.bank_id === bankId, "Created bank response used wrong bank_id.");
  console.log(`PASS create bank ${bankId}`);

  const emptyRecall = await requestJson(
    baseUrl,
    `/v1/default/banks/${bankId}/memories/recall`,
    {
      bearer,
      method: "POST",
      body: {
        query: "What lifecycle smoke marker is stored?",
        types: ["world", "experience"],
        max_tokens: 512,
      },
    },
  );
  expect(Array.isArray(emptyRecall.results), "Empty recall missing results.");
  expect(emptyRecall.results.length === 0, "New bank recall was not empty.");
  console.log("PASS recall empty bank");

  const retained = await requestJson(
    baseUrl,
    `/v1/default/banks/${bankId}/memories`,
    {
      bearer,
      method: "POST",
      body: {
        async: false,
        items: [
          {
            content: retainedFact,
            context: "Codex lifecycle smoke test",
            document_id: `smoke-test-${unique}`,
            tags: ["lifecycle-smoke"],
            timestamp: "unset",
          },
        ],
      },
    },
  );
  expect(retained.success === true, "Retain response did not report success.");
  expect(retained.bank_id === bankId, "Retain response used wrong bank_id.");
  expect(retained.items_count === 1, "Retain response used wrong item count.");
  console.log("PASS retain content");

  const retainedRecall = await requestJson(
    baseUrl,
    `/v1/default/banks/${bankId}/memories/recall`,
    {
      bearer,
      method: "POST",
      body: {
        query: "Which protocol does the Codex lifecycle smoke marker use?",
        types: ["world", "experience"],
        tags: ["lifecycle-smoke"],
        tags_match: "all_strict",
        max_tokens: 1024,
      },
    },
  );
  expect(
    Array.isArray(retainedRecall.results),
    "Retained recall missing results.",
  );
  expect(
    retainedRecall.results.some((result) =>
      resultText(result).toLowerCase().includes("heliotrope ledger protocol"),
    ),
    "Retained recall did not include the retained marker fact.",
  );
  console.log("PASS recall retained content");
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (bankCreated) {
    try {
      await requestJson(baseUrl, `/v1/default/banks/${bankId}`, {
        bearer,
        method: "DELETE",
      });
      console.log("PASS delete bank");
    } catch (error) {
      console.error(`FAIL delete bank: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("Lifecycle smoke test passed.");
