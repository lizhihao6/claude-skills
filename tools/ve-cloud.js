/**
 * Volcengine Cloud (ve) CLI and API Explorer tools
 *
 * Wraps the `ve` CLI for calling any Volcengine OpenAPI service,
 * plus free unauthenticated APIs for discovering services, actions, and specs.
 *
 * Requires: ve CLI (set VE_CLI_PATH env var, default ~/.local/bin/ve)
 * The ve CLI must be pre-configured with credentials (VOLCENGINE_ACCESS_KEY, etc.)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);
import { homedir } from "node:os";
const VE_CLI = process.env.VE_CLI_PATH || `${homedir()}/.local/bin/ve`;
const EXPLORER_BASE = "https://api.volcengine.com/api/common/explorer";

// --- Cache ---

const CACHE_DIR = join(process.env.HOME || "/tmp", ".cache", "claude-skills", "ve-explorer");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function cacheRead(filename) {
  try {
    const raw = await readFile(join(CACHE_DIR, filename), "utf-8");
    const data = JSON.parse(raw);
    if (data._cachedAt && Date.now() - data._cachedAt < CACHE_TTL_MS) {
      return data.value;
    }
  } catch {
    // cache miss — file missing, corrupt, or expired
  }
  return undefined;
}

async function cacheWrite(filename, value) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const data = JSON.stringify({ _cachedAt: Date.now(), value }, null, 2);
    await writeFile(join(CACHE_DIR, filename), data, "utf-8");
  } catch {
    // best-effort — don't fail the request if cache write fails
  }
}

// --- Helpers ---

async function veCliExists() {
  try {
    await access(VE_CLI, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runVe(args, { timeout = 30000 } = {}) {
  if (!(await veCliExists())) {
    throw new Error(
      `ve CLI not found at ${VE_CLI}. Set VE_CLI_PATH env var to the correct path, or install the Volcengine CLI.`
    );
  }
  try {
    const { stdout, stderr } = await exec(VE_CLI, args, {
      env: { ...process.env },
      timeout,
    });
    return stdout.trim();
  } catch (err) {
    const msg = err.stderr || err.message;
    throw new Error(`ve ${args.join(" ")} failed: ${msg}`);
  }
}

async function explorerFetch(path) {
  const url = `${EXPLORER_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Volcengine Explorer API ${url} failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  if (!json.Result) {
    throw new Error(`Volcengine Explorer API returned no Result: ${JSON.stringify(json)}`);
  }
  return json.Result;
}

// --- Tool implementations ---

async function vcCall({ service, action, params, version }) {
  // Build the service argument — some services need version suffix like "iam20210801"
  const svc = version ? `${service}${version.replace(/-/g, "")}` : service;
  const args = [svc, action];

  // Add params as --key value pairs
  if (params && typeof params === "object") {
    for (const [key, value] of Object.entries(params)) {
      args.push(`--${key}`, String(value));
    }
  }

  // Add JSON output flag
  args.push("-o", "json");

  const raw = await runVe(args, { timeout: 60000 });
  try {
    return JSON.parse(raw);
  } catch {
    return { rawOutput: raw };
  }
}

async function vcListServices({ forceRefresh } = {}) {
  const cacheFile = "services.json";
  if (!forceRefresh) {
    const cached = await cacheRead(cacheFile);
    if (cached !== undefined) return cached;
  }

  const result = await explorerFetch("/services");
  const categories = result.Categories || [];
  const value = categories.map((cat) => ({
    category: cat.CategoryName,
    services: (cat.Services || []).map((s) => ({
      name: s.ServiceCn || s.Product,
      code: s.ServiceCode,
      product: s.Product,
      regionType: s.RegionType,
    })),
  }));

  await cacheWrite(cacheFile, value);
  return value;
}

async function vcListActions({ serviceCode, version, forceRefresh }) {
  // If version not provided, fetch default version first
  let apiVersion = version;
  if (!apiVersion) {
    const vResult = await explorerFetch(`/versions?ServiceCode=${encodeURIComponent(serviceCode)}`);
    const versions = vResult.Versions || [];
    if (versions.length === 0) {
      throw new Error(`No API versions found for service "${serviceCode}"`);
    }
    const defaultVer = versions.find((v) => v.IsDefault === 1) || versions[0];
    apiVersion = defaultVer.Version;
  }

  const cacheFile = `${serviceCode}_${apiVersion}_actions.json`;
  if (!forceRefresh) {
    const cached = await cacheRead(cacheFile);
    if (cached !== undefined) return cached;
  }

  const result = await explorerFetch(
    `/apis?ServiceCode=${encodeURIComponent(serviceCode)}&APIVersion=${encodeURIComponent(apiVersion)}`
  );
  const groups = result.Groups || [];
  const value = {
    serviceCode,
    version: apiVersion,
    groups: groups.map((g) => ({
      group: g.Name,
      actions: (g.Apis || []).map((a) => ({
        action: a.Action,
        name: a.NameCn || a.Action,
        description: a.Description || "",
      })),
    })),
  };

  await cacheWrite(cacheFile, value);
  return value;
}

async function vcGetActionSpec({ serviceCode, version, action, forceRefresh }) {
  const cacheFile = `${serviceCode}_${version}_${action}_spec.json`;
  if (!forceRefresh) {
    const cached = await cacheRead(cacheFile);
    if (cached !== undefined) return cached;
  }

  const result = await explorerFetch(
    `/api-swagger?ServiceCode=${encodeURIComponent(serviceCode)}&APIVersion=${encodeURIComponent(version)}&ActionName=${encodeURIComponent(action)}`
  );
  const value = result.Api || result;

  await cacheWrite(cacheFile, value);
  return value;
}

// --- Tool definitions for MCP registration ---

export const tools = [
  {
    name: "vc_call",
    description:
      "Call any Volcengine OpenAPI via the ve CLI. Runs: ve <service> <Action> --param1 value1 ... -o json. Use vc_list_services and vc_list_actions to discover available services and actions first.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Volcengine service name, e.g. 'ecs', 'vpc', 'iam', 'cdn'",
        },
        action: {
          type: "string",
          description: "API action name, e.g. 'DescribeInstances', 'DescribeVpcs'",
        },
        params: {
          type: "object",
          description:
            "Key-value pairs passed as --key value flags to the ve CLI. Values are converted to strings.",
          additionalProperties: { type: "string" },
        },
        version: {
          type: "string",
          description:
            "API version string if the service requires a version suffix (e.g. '2021-08-01' for iam becomes 'iam20210801'). Most services do not need this.",
        },
      },
      required: ["service", "action"],
    },
    handler: vcCall,
  },
  {
    name: "vc_list_services",
    description:
      "List all available Volcengine cloud services by category. Returns service names, codes, and categories. No authentication required. Results are cached for 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        forceRefresh: {
          type: "boolean",
          description: "When true, bypass the local cache and fetch fresh data from the API.",
        },
      },
    },
    handler: vcListServices,
  },
  {
    name: "vc_list_actions",
    description:
      "List all available API actions for a Volcengine service, grouped by category. If version is omitted, the default version is used. No authentication required. Results are cached for 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        serviceCode: {
          type: "string",
          description: "Service code, e.g. 'ecs', 'vpc', 'iam'. Use vc_list_services to find codes.",
        },
        version: {
          type: "string",
          description: "API version, e.g. '2020-04-01'. If omitted, the default version is used.",
        },
        forceRefresh: {
          type: "boolean",
          description: "When true, bypass the local cache and fetch fresh data from the API.",
        },
      },
      required: ["serviceCode"],
    },
    handler: vcListActions,
  },
  {
    name: "vc_get_action_spec",
    description:
      "Get the full OpenAPI/Swagger spec for a specific Volcengine API action. Returns parameter definitions, request/response schemas. No authentication required. Results are cached for 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        serviceCode: {
          type: "string",
          description: "Service code, e.g. 'ecs'",
        },
        version: {
          type: "string",
          description: "API version, e.g. '2020-04-01'. Use vc_list_actions to find the version.",
        },
        action: {
          type: "string",
          description: "Action name, e.g. 'DescribeInstances'",
        },
        forceRefresh: {
          type: "boolean",
          description: "When true, bypass the local cache and fetch fresh data from the API.",
        },
      },
      required: ["serviceCode", "version", "action"],
    },
    handler: vcGetActionSpec,
  },
];
