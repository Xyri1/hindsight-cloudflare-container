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

const productionEnv = readProductionEnv();
const target =
  process.argv[2] ??
  process.env.HINDSIGHT_DEPLOYMENT_URL ??
  productionEnv.HINDSIGHT_DEPLOYMENT_URL;
const bearer =
  process.env.HINDSIGHT_PROXY_BEARER ?? productionEnv.HINDSIGHT_PROXY_BEARER;

if (!target) {
  console.error(
    "Usage: npm run test:deployment -- https://your-worker.example.workers.dev",
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

const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};

const checks = [
  {
    name: "API health",
    path: "/health",
    validate: async (response) => response.ok,
  },
  {
    name: "OpenAPI spec",
    path: "/openapi.json",
    validate: async (response) => {
      if (!response.ok) {
        return false;
      }

      const body = await response.json();
      return typeof body.openapi === "string";
    },
  },
  {
    name: "API docs",
    path: "/docs",
    validate: async (response) => response.ok,
  },
  {
    name: "Control Plane UI",
    path: "/",
    validate: async (response) => response.ok,
  },
];

let failed = false;

for (const check of checks) {
  const url = new URL(check.path, baseUrl);

  try {
    const response = await fetch(url, { headers });
    const passed = await check.validate(response);

    if (passed) {
      console.log(`PASS ${check.name} ${url} -> ${response.status}`);
      continue;
    }

    failed = true;
    console.error(`FAIL ${check.name} ${url} -> ${response.status}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${check.name} ${url} -> ${error.message}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log("Deployment smoke test passed.");
