/**
 * Tencent Cloud MCP tools
 *
 * Wraps `tccli` for calling any Tencent Cloud API, plus local discovery tools
 * that read the bundled api.json specs to list services, actions, and parameters
 * — no network calls required for discovery.
 *
 * Requires: tccli (set TCCLI_PATH env var, default: auto-detect via PATH)
 * The tccli must be pre-configured with credentials
 * (tccli configure or TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY env vars).
 *
 * Env vars:
 *   TCCLI_PATH          – path to the tccli binary (default: auto-detect)
 *   TENCENTCLOUD_REGION – default region (default: ap-singapore)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const exec = promisify(execFile);

const DEFAULT_REGION = process.env.TENCENTCLOUD_REGION || "ap-singapore";

// --- Resolve tccli path and services directory ---

function resolveTccli() {
  if (process.env.TCCLI_PATH) return process.env.TCCLI_PATH;
  try {
    return execSync("which tccli", { encoding: "utf8" }).trim();
  } catch {
    return "tccli";
  }
}

function resolveTccliServicesDir() {
  try {
    const bin = resolveTccli();
    // bin is like /opt/miniconda3/bin/tccli → base is /opt/miniconda3
    const base = dirname(dirname(bin));
    // Search for tccli services under lib/pythonX.Y/site-packages/tccli/services
    const libDir = join(base, "lib");
    if (!existsSync(libDir)) return null;
    const pyDirs = readdirSync(libDir).filter((d) => d.startsWith("python"));
    for (const pyDir of pyDirs) {
      const candidate = join(libDir, pyDir, "site-packages", "tccli", "services");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

const TCCLI = resolveTccli();
const SERVICES_DIR = resolveTccliServicesDir();

// --- Cache ---

const CACHE_DIR = join(
  process.env.HOME || "/tmp",
  ".cache",
  "claude-skills",
  "tc-explorer"
);
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function cacheRead(filename) {
  try {
    const raw = await readFile(join(CACHE_DIR, filename), "utf-8");
    const data = JSON.parse(raw);
    if (data._cachedAt && Date.now() - data._cachedAt < CACHE_TTL_MS) {
      return data.value;
    }
  } catch {
    // cache miss
  }
  return undefined;
}

async function cacheWrite(filename, value) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(
      join(CACHE_DIR, filename),
      JSON.stringify({ _cachedAt: Date.now(), value }, null, 2),
      "utf-8"
    );
  } catch {
    // best-effort
  }
}

// --- Core tccli runner ---

async function runTccli(service, action, region, params = {}) {
  const tmpFile = join(
    tmpdir(),
    `tc_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
  );
  try {
    await writeFile(tmpFile, JSON.stringify(params));
    const args = [
      service,
      action,
      "--region",
      region || DEFAULT_REGION,
      "--cli-input-json",
      `file://${tmpFile}`,
    ];
    const { stdout } = await exec(TCCLI, args, {
      timeout: 60000,
      env: { ...process.env },
    });
    const out = stdout.trim();
    try {
      return JSON.parse(out);
    } catch {
      return { rawOutput: out };
    }
  } catch (err) {
    const msg = err.stderr || err.stdout || err.message;
    throw new Error(`tccli ${service} ${action} failed: ${msg.trim()}`);
  } finally {
    try {
      await unlink(tmpFile);
    } catch {}
  }
}

// --- Discovery helpers (read local tccli api.json, no network) ---

function getServiceVersionDir(service) {
  if (!SERVICES_DIR) return null;
  const svcDir = join(SERVICES_DIR, service);
  if (!existsSync(svcDir)) return null;
  // Find the version directory (e.g. v20170312)
  const vDirs = readdirSync(svcDir).filter(
    (d) => d.startsWith("v") && existsSync(join(svcDir, d, "api.json"))
  );
  if (!vDirs.length) return null;
  // Use the latest version
  vDirs.sort().reverse();
  return { path: join(svcDir, vDirs[0], "api.json"), version: vDirs[0] };
}

// --- Tool implementations ---

async function tcCall({ service, action, region, params }) {
  return runTccli(service, action, region, params || {});
}

async function tcListServices() {
  const cacheKey = "tc_services.json";
  const cached = await cacheRead(cacheKey);
  if (cached !== undefined) return cached;

  if (!SERVICES_DIR) {
    throw new Error(
      "Cannot locate tccli services directory. Set TCCLI_PATH env var."
    );
  }

  const entries = readdirSync(SERVICES_DIR).filter(
    (d) => !d.startsWith("_") && !d.startsWith(".") && !d.includes(".")
  );

  const services = [];
  for (const svc of entries) {
    const info = getServiceVersionDir(svc);
    if (!info) continue;
    try {
      const apiData = JSON.parse(
        readFileSync(info.path, "utf-8")
      );
      const actionCount = Object.keys(apiData.actions || {}).length;
      services.push({
        service: svc,
        version: info.version,
        actionCount,
        docsUrl: `https://cloud.tencent.com/document/api/${svc}`,
      });
    } catch {
      services.push({ service: svc, version: info.version });
    }
  }

  services.sort((a, b) => a.service.localeCompare(b.service));
  await cacheWrite(cacheKey, services);
  return services;
}

async function tcListActions({ service }) {
  const cacheKey = `tc_actions_${service}.json`;
  const cached = await cacheRead(cacheKey);
  if (cached !== undefined) return cached;

  const info = getServiceVersionDir(service);
  if (!info) {
    throw new Error(
      `Service "${service}" not found in tccli. Use tc_list_services to see available services.`
    );
  }

  const apiData = JSON.parse(
    readFileSync(info.path, "utf-8")
  );
  const actions = Object.entries(apiData.actions || {}).map(
    ([name, meta]) => ({
      action: name,
      name: meta.name || name,
      description: (meta.document || "").split("\n")[0].slice(0, 120),
      status: meta.status,
    })
  );

  actions.sort((a) => (a.status === "online" ? -1 : 1));

  const result = { service, version: info.version, actions };
  await cacheWrite(cacheKey, result);
  return result;
}

async function tcGetActionSpec({ service, action }) {
  const info = getServiceVersionDir(service);
  if (!info) {
    throw new Error(`Service "${service}" not found.`);
  }

  const apiData = JSON.parse(
    readFileSync(info.path, "utf-8")
  );
  const actionMeta = apiData.actions?.[action];
  if (!actionMeta) {
    throw new Error(
      `Action "${action}" not found in service "${service}". Use tc_list_actions to see available actions.`
    );
  }

  // Resolve input parameters from objects
  const inputType = actionMeta.input;
  const inputObj = apiData.objects?.[inputType];

  const params =
    inputObj?.members?.map((m) => ({
      name: m.name,
      type: m.type,
      required: m.required,
      description: (m.document || "").slice(0, 200),
      example: m.example,
    })) || [];

  return {
    service,
    version: info.version,
    action,
    name: actionMeta.name,
    description: actionMeta.document,
    docsUrl: `https://cloud.tencent.com/document/api/${service}/${action}`,
    params,
  };
}

// --- Tool definitions ---

export const tools = [
  {
    name: "tc_call",
    description:
      "Call any Tencent Cloud API via tccli. Supports all services: cvm, vpc, redis, postgres, tke, cls, cos, cdn, etc. Use tc_list_services / tc_list_actions / tc_get_action_spec to discover available services and parameters first.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            "Service name, e.g. 'cvm', 'vpc', 'redis', 'postgres', 'tke', 'clb', 'cdn'",
        },
        action: {
          type: "string",
          description:
            "API action name, e.g. 'DescribeInstances', 'CreateSecurityGroupPolicies'",
        },
        region: {
          type: "string",
          description: `Region, e.g. 'ap-singapore', 'ap-guangzhou'. Default: ${DEFAULT_REGION}`,
        },
        params: {
          type: "object",
          description:
            "API request parameters as a JSON object. Use tc_get_action_spec to see available parameters.",
        },
      },
      required: ["service", "action"],
    },
    handler: tcCall,
  },
  {
    name: "tc_list_services",
    description:
      "List all Tencent Cloud services available in tccli (250+ services). Returns service codes, versions, and action counts. Read from local tccli install — no network needed. Results cached 6h.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: tcListServices,
  },
  {
    name: "tc_list_actions",
    description:
      "List all API actions for a Tencent Cloud service, with Chinese names and descriptions. Read from local tccli api.json — no network needed. Results cached 6h.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            "Service code, e.g. 'cvm', 'vpc', 'redis'. Use tc_list_services to find codes.",
        },
      },
      required: ["service"],
    },
    handler: tcListActions,
  },
  {
    name: "tc_get_action_spec",
    description:
      "Get full parameter spec for a specific Tencent Cloud API action — parameter names, types, required flags, descriptions, and examples. Also returns the official docs URL. No network needed.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service code, e.g. 'cvm'",
        },
        action: {
          type: "string",
          description:
            "Action name, e.g. 'DescribeInstances'. Use tc_list_actions to find action names.",
        },
      },
      required: ["service", "action"],
    },
    handler: tcGetActionSpec,
  },
];
