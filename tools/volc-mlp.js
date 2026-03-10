/**
 * Volcengine ML Platform (MLP) task management tools
 *
 * Wraps the `volc` CLI for managing distributed training tasks,
 * plus direct OpenAPI calls for operations not available via CLI.
 *
 * Requires: volc CLI at ~/.volc/bin/volc (pre-configured via `volc configure`)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";

const exec = promisify(execFile);
const VOLC = process.env.VOLC_CLI_PATH || `${homedir()}/.volc/bin/volc`;
const ENV = { ...process.env, PATH: `${VOLC.replace(/\/volc$/, "")}:${process.env.PATH}` };

// OpenAPI configuration for direct API calls
const OPENAPI_HOST = "open.volcengineapi.com";
const OPENAPI_SERVICE = "ml_platform";
const OPENAPI_VERSION = "2021-10-01";
const OPENAPI_REGION = process.env.VOLC_REGION || "cn-beijing";

async function volc(args, { timeout = 30000 } = {}) {
  try {
    const { stdout, stderr } = await exec(VOLC, args, { env: ENV, timeout });
    return stdout.trim();
  } catch (err) {
    // For timeout errors (e.g. from `top`), return whatever output was captured
    if (err.killed && err.stdout) {
      return err.stdout.trim();
    }
    throw new Error(`volc ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

async function parseJsonOutput(args, opts) {
  const raw = await volc(args, opts);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// --- Tool implementations ---

async function submitTask(yamlPath) {
  const output = await volc(["ml_task", "submit", "-c", yamlPath], { timeout: 60000 });
  return { output };
}

async function listTasks({ status, name, limit, offset }) {
  const args = ["ml_task", "list", "-o", "json"];
  if (status) args.push("-s", status);
  if (name) args.push("-n", name);
  if (limit) args.push("--limit", String(limit));
  if (offset) args.push("--offset", String(offset));
  return parseJsonOutput(args);
}

async function getTask(taskId) {
  // `volc ml_task get` opens an interactive TUI, so we emulate it
  // by listing with all statuses and filtering by task ID
  const args = [
    "ml_task", "list",
    "-s", "Queue,Staging,Running,Killing,Success,Failed,Killed,Initialized",
    "-n", taskId,
    "-o", "json",
    "--limit", "1",
  ];
  const result = await parseJsonOutput(args);
  // result is an array; return the first match or indicate not found
  if (Array.isArray(result) && result.length > 0) {
    return result[0];
  }
  return { error: "Task not found", taskId };
}

async function listInstances(taskId) {
  return parseJsonOutput(["ml_task", "instance", "list", "-i", taskId, "-o", "json"]);
}

async function getLogs({ taskId, instance, lines, reverse, filter, startTime, endTime, logFile, listFiles }) {
  // If listFiles is true, list available log files for the instance
  if (listFiles) {
    const args = ["ml_task", "logs", "-t", taskId, "-i", instance || "worker-0", "--list"];
    return { files: await volc(args, { timeout: 30000 }) };
  }

  const args = ["ml_task", "logs", "-t", taskId, "-i", instance || "worker-0"];
  if (lines) args.push("-l", String(lines));
  if (reverse) args.push("-r");
  if (filter) args.push("-c", filter);
  if (startTime) args.push("--start-time", startTime);
  if (endTime) args.push("--end-time", endTime);
  if (logFile) args.push("--log-file", logFile);
  return { logs: await volc(args, { timeout: 60000 }) };
}

async function cancelTask(taskId) {
  const output = await volc(["ml_task", "cancel", "-i", taskId]);
  return { success: true, taskId, output };
}

async function attachExec({ taskId, instance, command }) {
  const args = ["ml_task", "attach", "-t", taskId, "-i", instance || "worker-0"];
  if (command) args.push("--exec", command);
  return { output: await volc(args, { timeout: 60000 }) };
}

async function topGpu({ taskId, instance }) {
  // `volc ml_task top` is an interactive/streaming command similar to `nvidia-smi`.
  // We capture output with a short timeout so we get at least one snapshot.
  const args = ["ml_task", "top", "-t", taskId, "-i", instance || "worker-0"];
  try {
    const output = await volc(args, { timeout: 10000 });
    return { output };
  } catch (err) {
    // timeout is expected — extract partial output from the error
    const msg = err.message || "";
    if (msg.includes("SIGTERM") || msg.includes("timed out")) {
      // Try to extract any captured output from the error
      return { output: msg, note: "Command timed out (expected for streaming `top`). Partial output shown." };
    }
    throw err;
  }
}

// --- OpenAPI helpers (for operations not available via CLI) ---

/**
 * Call a Volcengine ML Platform OpenAPI action using the `volc` CLI as a proxy.
 * Falls back to describing the curl command if the CLI doesn't support it directly.
 */
async function mlpApiCall(action, body = {}) {
  // Use the ve CLI pattern: the volc CLI wraps OpenAPI calls
  // Construct the call via `volc` if supported, otherwise describe the action
  const args = [
    "ml_platform", action,
    "--body", JSON.stringify(body),
    "-o", "json",
  ];
  try {
    return await parseJsonOutput(args, { timeout: 30000 });
  } catch {
    // If the volc CLI doesn't support this action directly,
    // provide a helpful error with the equivalent curl command
    throw new Error(
      `Direct OpenAPI call for ${action} not available via volc CLI. ` +
      `Use the vc_call tool instead: vc_call({ service: "ml_platform", action: "${action}", params: ${JSON.stringify(body)} })`
    );
  }
}

async function deleteTask(taskId) {
  // Try CLI first (not all versions support this), fall back to API guidance
  try {
    return await mlpApiCall("DeleteJob", { Id: taskId });
  } catch {
    // Provide manual guidance
    return {
      note: "DeleteJob is not available via the volc CLI in this version. Use the vc_call tool instead.",
      example: `vc_call({ service: "ml_platform", action: "DeleteJob", params: { Id: "${taskId}" }, version: "${OPENAPI_VERSION}" })`,
      taskId,
    };
  }
}

async function modifyPriority({ taskId, priority }) {
  try {
    return await mlpApiCall("ModifyJobPriority", { Id: taskId, Priority: priority });
  } catch {
    return {
      note: "ModifyJobPriority is not available via the volc CLI in this version. Use the vc_call tool instead.",
      example: `vc_call({ service: "ml_platform", action: "ModifyJobPriority", params: { Id: "${taskId}", Priority: "${priority}" }, version: "${OPENAPI_VERSION}" })`,
      taskId,
      priority,
    };
  }
}

// --- Dev Instance (开发机) operations ---

async function createDevInstance({ name, imageUrl, queueId, flavorId, volumeType, volumeSize, sshPublicKey, storages, description }) {
  const body = {
    Name: name,
    Image: { Url: imageUrl },
    QueueId: queueId,
    FlavorId: flavorId,
    Volume: { Type: volumeType || "ml.essd.pl1", Size: volumeSize || 20 },
  };
  if (description) body.Description = description;
  if (sshPublicKey) body.SshPublicKey = sshPublicKey;
  if (storages) body.Storages = storages;
  try {
    return await mlpApiCall("CreateDevInstance", body);
  } catch {
    return {
      note: "CreateDevInstance not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "CreateDevInstance", params: ${JSON.stringify(body)}, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

async function getDevInstance(id) {
  try {
    return await mlpApiCall("GetDevInstance", { Id: id });
  } catch {
    return {
      note: "GetDevInstance not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "GetDevInstance", params: { Id: "${id}" }, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

async function listDevInstances({ offset, limit, sortBy, sortOrder, nameContains, idContains, states, queueIds }) {
  const body = {};
  if (offset != null) body.Offset = offset;
  if (limit != null) body.Limit = limit;
  if (sortBy) body.SortBy = sortBy;
  if (sortOrder) body.SortOrder = sortOrder;
  if (nameContains) body.NameContains = nameContains;
  if (idContains) body.IdContains = idContains;
  if (states) body.States = states;
  if (queueIds) body.QueueIds = queueIds;
  try {
    return await mlpApiCall("ListDevInstances", body);
  } catch {
    return {
      note: "ListDevInstances not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "ListDevInstances", params: ${JSON.stringify(body)}, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

async function stopDevInstance(id) {
  try {
    return await mlpApiCall("StopDevInstance", { Id: id });
  } catch {
    return {
      note: "StopDevInstance not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "StopDevInstance", params: { Id: "${id}" }, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

async function startDevInstance(id) {
  try {
    return await mlpApiCall("StartDevInstance", { Id: id });
  } catch {
    return {
      note: "StartDevInstance not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "StartDevInstance", params: { Id: "${id}" }, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

async function deleteDevInstance(id) {
  try {
    return await mlpApiCall("DeleteDevInstance", { Id: id });
  } catch {
    return {
      note: "DeleteDevInstance not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "DeleteDevInstance", params: { Id: "${id}" }, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

// --- Custom Task (自定义任务) operations ---

async function createCustomTask({ name, imageUrl, imageType, entrypointPath, framework, taskRoleSpecs, resourceQueueId, storages, envs, priority, preemptible, activeDeadlineSeconds, delayExitTimeSeconds, description, diagOptions, retryOptions }) {
  const body = {
    Name: name,
    ImageSpec: { Url: imageUrl, Type: imageType || "Custom" },
    EntrypointPath: entrypointPath,
    Framework: framework || "PyTorchDDP",
    TaskRoleSpecs: taskRoleSpecs,
  };
  if (resourceQueueId) body.ResourceQueueId = resourceQueueId;
  if (storages) body.Storages = storages;
  if (envs) body.Envs = envs;
  if (priority != null) body.Priority = priority;
  if (preemptible != null) body.Preemptible = preemptible;
  if (activeDeadlineSeconds != null) body.ActiveDeadlineSeconds = activeDeadlineSeconds;
  if (delayExitTimeSeconds != null) body.DelayExitTimeSeconds = delayExitTimeSeconds;
  if (description) body.Description = description;
  if (diagOptions) body.DiagOptions = diagOptions;
  if (retryOptions) body.RetryOptions = retryOptions;
  try {
    return await mlpApiCall("CreateCustomTask", body);
  } catch {
    return {
      note: "CreateCustomTask not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "CreateCustomTask", params: ${JSON.stringify(body)}, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

async function stopCustomTask(taskId) {
  try {
    return await mlpApiCall("StopCustomTask", { Id: taskId });
  } catch {
    return {
      note: "StopCustomTask not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "StopCustomTask", params: { Id: "${taskId}" }, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

// --- Diagnostics (可观测) ---

async function listDiagnosisTimelines(workloadId) {
  try {
    return await mlpApiCall("ListDiagnosisTimelines", { WorkloadId: workloadId });
  } catch {
    return {
      note: "ListDiagnosisTimelines not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "ListDiagnosisTimelines", params: { WorkloadId: "${workloadId}" }, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

// --- Resource Groups (资源组) ---

async function listResourceGroups({ filter, states, chargeType, sortBy, sortOrder, limit, offset }) {
  const body = {};
  if (filter) body.Filter = filter;
  if (states) body.States = states;
  if (chargeType) body.ChargeType = chargeType;
  if (sortBy) body.SortBy = sortBy;
  if (sortOrder) body.SortOrder = sortOrder;
  if (limit != null) body.Limit = limit;
  if (offset != null) body.Offset = offset;
  try {
    return await mlpApiCall("ListResourceGroups", body);
  } catch {
    return {
      note: "ListResourceGroups not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "ListResourceGroups", params: ${JSON.stringify(body)}, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

// --- Flavors (计算规格) ---

async function listFlavors({ resourceGroupId, queueId }) {
  const body = {};
  if (resourceGroupId) body.ResourceGroupId = resourceGroupId;
  if (queueId) body.ResourceQueueId = queueId;
  try {
    return await mlpApiCall("ListFlavors", body);
  } catch {
    return {
      note: "ListFlavors not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "ListFlavors", params: ${JSON.stringify(body)}, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

// --- Queues (队列) ---

async function listQueues({ offset, limit }) {
  const body = {};
  if (offset != null) body.Offset = offset;
  if (limit != null) body.Limit = limit;
  try {
    return await mlpApiCall("ListResourceQueues", body);
  } catch {
    return {
      note: "ListResourceQueues not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "ListResourceQueues", params: ${JSON.stringify(body)}, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

async function listQueueUsers({ resourceQueueId, role, limit, offset, sortBy, sortOrder }) {
  const body = { ResourceQueueId: resourceQueueId };
  if (role) body.Role = role;
  if (limit != null) body.Limit = limit;
  if (offset != null) body.Offset = offset;
  if (sortBy) body.SortBy = sortBy;
  if (sortOrder) body.SortOrder = sortOrder;
  try {
    return await mlpApiCall("ListResourceQueueUsers", body);
  } catch {
    return {
      note: "ListResourceQueueUsers not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "ListResourceQueueUsers", params: ${JSON.stringify(body)}, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

// --- Image saving (保存镜像) ---

async function saveImage({ registry, namespace, repo, name, devInstanceId, excludeDirs }) {
  const body = {
    Registry: registry,
    Namespace: namespace,
    Repo: repo,
    Name: name,
    BuildMode: "DevInstance",
    DevInstanceId: devInstanceId,
  };
  if (excludeDirs) body.ExcludeDirs = excludeDirs;
  try {
    return await mlpApiCall("CreateImageTag", body);
  } catch {
    return {
      note: "CreateImageTag not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "CreateImageTag", params: ${JSON.stringify(body)}, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

// --- vePFS permissions (vePFS子目录挂载权限) ---

async function listVepfsPermissions({ vepfsIds, azs, directories, limit, offset, sortBy, sortOrder }) {
  const body = { VepfsIds: vepfsIds };
  if (azs) body.AZs = azs;
  if (directories) body.Directories = directories;
  if (limit != null) body.Limit = limit;
  if (offset != null) body.Offset = offset;
  if (sortBy) body.SortBy = sortBy;
  if (sortOrder) body.SortOrder = sortOrder;
  try {
    return await mlpApiCall("ListVepfsFilesetPermission", body);
  } catch {
    return {
      note: "ListVepfsFilesetPermission not available via volc CLI. Use vc_call tool.",
      example: `vc_call({ service: "ml_platform", action: "ListVepfsFilesetPermission", params: ${JSON.stringify(body)}, version: "${OPENAPI_VERSION}" })`,
    };
  }
}

// --- Tool definitions ---

export const tools = [
  {
    name: "mlp_submit_task",
    description: "Submit a training task to Volcengine ML Platform using a YAML config file",
    inputSchema: {
      type: "object",
      properties: {
        yamlPath: { type: "string", description: "Path to the task YAML config file, e.g. scripts/mlp/yaml/xxx.yaml" },
      },
      required: ["yamlPath"],
    },
    handler: ({ yamlPath }) => submitTask(yamlPath),
  },
  {
    name: "mlp_list_tasks",
    description: "List training tasks on Volcengine ML Platform. Filter by status (Queue/Staging/Running/Failed/Success/Killed/Killing/Initialized) and name.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Comma-separated status filter: Queue,Staging,Running,Failed,Success,Killed,Killing,Initialized" },
        name: { type: "string", description: "Filter by task name or task ID" },
        limit: { type: "number", description: "Max results (default 20)" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
    handler: listTasks,
  },
  {
    name: "mlp_get_task",
    description:
      "Get detailed info for a single task by its ID. Searches across all statuses. " +
      "Returns: JobId, JobName, Status, Start, End, Elapsed, Creator, TaskRoleSpecs, Framework, ResourceQueueId.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to look up" },
      },
      required: ["taskId"],
    },
    handler: ({ taskId }) => getTask(taskId),
  },
  {
    name: "mlp_list_instances",
    description:
      "List instances (worker pods/nodes) of a training task, showing state, exit code, and diagnostics. " +
      "Returns: Name, State, FlavorId, ExitCode, LaunchTime, FinishTime, DiagInfo.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
      },
      required: ["taskId"],
    },
    handler: ({ taskId }) => listInstances(taskId),
  },
  {
    name: "mlp_get_logs",
    description:
      "Get logs from a training task instance. Use to diagnose failures or monitor progress. " +
      "Set listFiles=true to discover available log files before reading them.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
        instance: { type: "string", description: "Instance short name, e.g. worker-0 (default: worker-0)" },
        lines: { type: "number", description: "Number of log lines (default 500)" },
        reverse: { type: "boolean", description: "Show earliest logs first (default: latest first)" },
        filter: { type: "string", description: "Filter log content by string" },
        startTime: { type: "string", description: "Start time, e.g. '2026-03-08 08:00:00'" },
        endTime: { type: "string", description: "End time, e.g. '2026-03-08 09:00:00'" },
        logFile: { type: "string", description: "Specific log file to read (default: stdout&stderr). Use listFiles=true to discover available files." },
        listFiles: { type: "boolean", description: "If true, list available log files for the instance instead of fetching logs" },
      },
      required: ["taskId"],
    },
    handler: getLogs,
  },
  {
    name: "mlp_cancel_task",
    description: "Cancel a running or queued training task on Volcengine ML Platform",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to cancel" },
      },
      required: ["taskId"],
    },
    handler: ({ taskId }) => cancelTask(taskId),
  },
  {
    name: "mlp_attach",
    description:
      "Execute a command inside a running training container. Only works on Running tasks. " +
      "Use for debugging: nvidia-smi, ps aux, checking env, etc.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
        instance: { type: "string", description: "Instance short name, e.g. worker-0 (default: worker-0)" },
        command: { type: "string", description: "Command to execute, e.g. 'nvidia-smi' or 'ps aux | grep python'" },
      },
      required: ["taskId"],
    },
    handler: attachExec,
  },
  {
    name: "mlp_top",
    description:
      "Monitor GPU utilization of a running training task instance. " +
      "Captures a snapshot of GPU stats (like nvidia-smi). " +
      "The underlying command is streaming, so output is captured with a short timeout.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
        instance: { type: "string", description: "Instance short name, e.g. worker-0 (default: worker-0)" },
      },
      required: ["taskId"],
    },
    handler: topGpu,
  },
  {
    name: "mlp_delete_task",
    description:
      "Delete a completed training task (Success/Failed/Killed) from Volcengine ML Platform. " +
      "Cannot delete running or queued tasks — cancel them first.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to delete" },
      },
      required: ["taskId"],
    },
    handler: ({ taskId }) => deleteTask(taskId),
  },
  {
    name: "mlp_modify_priority",
    description:
      "Change the scheduling priority of a queued or running training task. " +
      "Priority range: 1-9 (higher = more priority). Only affects Queue/Running tasks.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
        priority: { type: "number", description: "New priority (1-9, higher = more priority)" },
      },
      required: ["taskId", "priority"],
    },
    handler: modifyPriority,
  },

  // --- Dev Instance tools ---
  {
    name: "mlp_create_dev_instance",
    description:
      "Create a new dev instance (开发机) on Volcengine ML Platform. " +
      "Requires a name, image URL, queue ID, and flavor ID. " +
      "Returns the new dev instance ID.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Dev instance name" },
        imageUrl: { type: "string", description: "Docker image URL, e.g. vemlp-cn-beijing.cr.volces.com/preset-images/pytorch:2.1.0-cu11.8.0-py3.11-ubuntu20.04" },
        queueId: { type: "string", description: "Resource queue ID, e.g. q-20241021215420-xxxxx" },
        flavorId: { type: "string", description: "Compute flavor ID, e.g. ml.g3a.4xlarge" },
        volumeType: { type: "string", description: "Cloud disk type (default: ml.essd.pl1). Options: ml.essd.pl0, ml.essd.pl1" },
        volumeSize: { type: "number", description: "Cloud disk size in GiB (default: 20, range: 20-30196)" },
        sshPublicKey: { type: "string", description: "SSH public key for remote access" },
        storages: {
          type: "array",
          description: "Shared storage mounts. Each item: { Type: 'Vepfs'|'Tos'|'Nas', MountPath: '/data', VepfsId/Bucket/NasId: '...' }",
          items: { type: "object" },
        },
        description: { type: "string", description: "Description of the dev instance" },
      },
      required: ["name", "imageUrl", "queueId", "flavorId"],
    },
    handler: createDevInstance,
  },
  {
    name: "mlp_get_dev_instance",
    description:
      "Get details of a dev instance (开发机) by ID. " +
      "Returns: Id, Name, State (Pending/Deploying/Running/Stopping/Stopped/Deleting/Abnormal), " +
      "Image, QueueId, FlavorId, Volume, network info, StorageConfig, WebIDE URL, timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Dev instance ID, e.g. di-20241104122530-xxxxx" },
      },
      required: ["id"],
    },
    handler: ({ id }) => getDevInstance(id),
  },
  {
    name: "mlp_list_dev_instances",
    description:
      "List dev instances (开发机) on Volcengine ML Platform. " +
      "Filter by name, ID, states, or queue. " +
      "States: Pending, Deploying, Running, Stopping, Stopped, Deleting, Abnormal.",
    inputSchema: {
      type: "object",
      properties: {
        offset: { type: "number", description: "Pagination offset (default: 0)" },
        limit: { type: "number", description: "Max results per page (default: 10, max: 300)" },
        sortBy: { type: "string", description: "Sort field: CreateTime (default)" },
        sortOrder: { type: "string", description: "Sort order: Descend (default) or Ascend" },
        nameContains: { type: "string", description: "Filter by name (fuzzy match)" },
        idContains: { type: "string", description: "Filter by ID (fuzzy match)" },
        states: {
          type: "array",
          items: { type: "string" },
          description: "Filter by states: Pending, Deploying, Running, Stopping, Stopped, Deleting, Abnormal",
        },
        queueIds: {
          type: "array",
          items: { type: "string" },
          description: "Filter by queue IDs",
        },
      },
    },
    handler: (params) => listDevInstances(params || {}),
  },
  {
    name: "mlp_stop_dev_instance",
    description: "Stop (shut down) a running dev instance (开发机). The instance can be restarted later.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Dev instance ID to stop" },
      },
      required: ["id"],
    },
    handler: ({ id }) => stopDevInstance(id),
  },
  {
    name: "mlp_start_dev_instance",
    description: "Start (power on) a stopped dev instance (开发机).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Dev instance ID to start" },
      },
      required: ["id"],
    },
    handler: ({ id }) => startDevInstance(id),
  },
  {
    name: "mlp_delete_dev_instance",
    description: "Delete a dev instance (开发机). This is irreversible. Stop the instance first if it is running.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Dev instance ID to delete" },
      },
      required: ["id"],
    },
    handler: ({ id }) => deleteDevInstance(id),
  },

  // --- Custom Task (direct API) ---
  {
    name: "mlp_create_task",
    description:
      "Create a custom training task via the OpenAPI (not YAML). " +
      "Use mlp_submit_task for YAML-based submission. This tool offers direct API control. " +
      "Framework options: PyTorchDDP, TensorFlowPS, BytePS, Horovod, MPI, Slurm, Custom, Ray.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name" },
        imageUrl: { type: "string", description: "Docker image URL" },
        imageType: { type: "string", description: "Image type: Custom (default), Preset, VolcEngine, Public" },
        entrypointPath: { type: "string", description: "Container entrypoint command, e.g. 'torchrun --nproc_per_node 8 train.py'" },
        framework: { type: "string", description: "Training framework: PyTorchDDP (default), TensorFlowPS, MPI, Slurm, Custom, Ray, etc." },
        taskRoleSpecs: {
          type: "array",
          description: "Worker role specs. Each item: { RoleName: 'worker', RoleReplicas: 4, ResourceSpec: { FlavorID: 'ml.hpcpni2l.28xlarge', ZoneId: 'cn-beijing-b' } }",
          items: { type: "object" },
        },
        resourceQueueId: { type: "string", description: "Resource queue ID, e.g. q-xxxxx" },
        storages: {
          type: "array",
          description: "Storage mounts. Each: { Type: 'Vepfs'|'Tos'|'Nas', MountPath: '/data', VepfsId/Bucket/NasId: '...' }",
          items: { type: "object" },
        },
        envs: {
          type: "array",
          description: "Environment variables. Each: { Name: 'KEY', Value: 'val' }",
          items: { type: "object" },
        },
        priority: { type: "number", description: "Scheduling priority: 2, 4, or 6 (default: queue default)" },
        preemptible: { type: "boolean", description: "Whether the task can be preempted" },
        activeDeadlineSeconds: { type: "number", description: "Max runtime in seconds (-1 for unlimited)" },
        delayExitTimeSeconds: { type: "number", description: "Delay before cleanup after task ends (seconds)" },
        description: { type: "string", description: "Task description" },
        diagOptions: {
          type: "array",
          description: "Diagnosis options. Each: { Name: 'EnvironmentalDiagnosis'|'PythonDetection'|'LogDetection', Enable: true, Triggers: ['BeforeStart','TaskFailed'] }",
          items: { type: "object" },
        },
        retryOptions: {
          type: "object",
          description: "Retry config: { EnableRetry: true, MaxRetryTimes: 5, IntervalSeconds: 120, PolicySets: ['Failed'] }",
        },
      },
      required: ["name", "imageUrl", "entrypointPath", "taskRoleSpecs"],
    },
    handler: createCustomTask,
  },
  {
    name: "mlp_stop_task",
    description:
      "Stop (gracefully cancel) a submitted custom task via the OpenAPI. " +
      "Different from mlp_cancel_task which uses the CLI. This calls StopCustomTask API directly.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to stop, e.g. t-20230206155441-lfpdz" },
      },
      required: ["taskId"],
    },
    handler: ({ taskId }) => stopCustomTask(taskId),
  },

  // --- Diagnostics ---
  {
    name: "mlp_list_diagnosis",
    description:
      "List diagnosis timelines for a training task. Shows environmental diagnosis, Python detection, " +
      "and log detection results with states (Running/Passed/Failed), timestamps, and trigger conditions.",
    inputSchema: {
      type: "object",
      properties: {
        workloadId: { type: "string", description: "Task ID to query diagnostics for, e.g. t-20241022170814-7l5cj" },
      },
      required: ["workloadId"],
    },
    handler: ({ workloadId }) => listDiagnosisTimelines(workloadId),
  },

  // --- Resource Groups ---
  {
    name: "mlp_list_resource_groups",
    description:
      "List resource groups (资源组) on Volcengine ML Platform. " +
      "Shows ID, name, state, GPU/CPU capacity, flavor allocations, expiry, and charge type. " +
      "Filter by name/ID, state (Running/Expired/Overdue/Reclaimed), or charge type (PostPaid/PrePaid).",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Fuzzy search by name or ID" },
        states: {
          type: "array",
          items: { type: "string" },
          description: "Filter by state: Running, Expired, Overdue, Reclaimed",
        },
        chargeType: { type: "string", description: "Filter by charge type: PostPaid or PrePaid" },
        sortBy: { type: "string", description: "Sort by: ResourceGroupName, ExpiredTime, CreateTime" },
        sortOrder: { type: "string", description: "Sort order: Ascend or Descend" },
        limit: { type: "number", description: "Max results (default: 10, max: 300)" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
    handler: (params) => listResourceGroups(params || {}),
  },

  // --- Flavors ---
  {
    name: "mlp_list_flavors",
    description:
      "List available compute flavors (计算规格) on Volcengine ML Platform. " +
      "Each flavor defines vCPU, memory, GPU type/count/memory, pricing, RDMA, and disk specs. " +
      "Optionally filter by resource group or queue.",
    inputSchema: {
      type: "object",
      properties: {
        resourceGroupId: { type: "string", description: "Filter by resource group ID" },
        queueId: { type: "string", description: "Filter by resource queue ID" },
      },
    },
    handler: (params) => listFlavors(params || {}),
  },

  // --- Queues ---
  {
    name: "mlp_list_queues",
    description:
      "List resource queues (资源队列) on Volcengine ML Platform. " +
      "Shows queue IDs, names, associated resource groups, and quota information.",
    inputSchema: {
      type: "object",
      properties: {
        offset: { type: "number", description: "Pagination offset" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
    },
    handler: (params) => listQueues(params || {}),
  },
  {
    name: "mlp_list_queue_users",
    description:
      "List users of a resource queue (队列用户) on Volcengine ML Platform. " +
      "Shows user IDs, roles (Admin/General/Joining/Rejected), usage limits, and quota info.",
    inputSchema: {
      type: "object",
      properties: {
        resourceQueueId: { type: "string", description: "Resource queue ID, e.g. q-20250610203917-hx8dc" },
        role: { type: "string", description: "Filter by role: Admin, General, Joining, Rejected" },
        limit: { type: "number", description: "Max results (max: 300)" },
        offset: { type: "number", description: "Pagination offset" },
        sortBy: { type: "string", description: "Sort by: CreateTime (default), UpdateTime" },
        sortOrder: { type: "string", description: "Sort order: Ascend or Descend (default)" },
      },
      required: ["resourceQueueId"],
    },
    handler: listQueueUsers,
  },

  // --- Save Image ---
  {
    name: "mlp_save_image",
    description:
      "Save a running dev instance as a Docker image (保存镜像). " +
      "Creates an image tag from the current state of a dev instance (must be Running). " +
      "The image is saved to the specified container registry namespace/repo.",
    inputSchema: {
      type: "object",
      properties: {
        registry: { type: "string", description: "Container registry instance name, e.g. vemlp-public" },
        namespace: { type: "string", description: "Registry namespace, e.g. apig" },
        repo: { type: "string", description: "Image repository name" },
        name: { type: "string", description: "Image tag/version, e.g. v1.0" },
        devInstanceId: { type: "string", description: "Source dev instance ID (must be Running), e.g. di-20241022xxx1-gxmkj" },
        excludeDirs: {
          type: "array",
          items: { type: "string" },
          description: "Directories to exclude from the image, e.g. ['/root/code/data', '/tmp']",
        },
      },
      required: ["registry", "namespace", "repo", "name", "devInstanceId"],
    },
    handler: saveImage,
  },

  // --- vePFS Permissions ---
  {
    name: "mlp_list_vepfs_permissions",
    description:
      "List vePFS subdirectory mount permission rules (vePFS子目录挂载权限). " +
      "Shows which users/groups have read-write or read-only access to specific vePFS directories.",
    inputSchema: {
      type: "object",
      properties: {
        vepfsIds: {
          type: "array",
          items: { type: "string" },
          description: "vePFS instance IDs to query, e.g. ['vepfs-cnbjc7bb8cxxxxxx']",
        },
        azs: {
          type: "array",
          items: { type: "string" },
          description: "Filter by availability zone IDs, e.g. ['cn-beijing-b']",
        },
        directories: {
          type: "array",
          items: { type: "string" },
          description: "Filter by directory paths, e.g. ['/users/xxx']",
        },
        limit: { type: "number", description: "Max results per page (default: 100)" },
        offset: { type: "number", description: "Pagination offset" },
        sortBy: { type: "string", description: "Sort by field, e.g. UpdateTime" },
        sortOrder: { type: "string", description: "Sort order: Ascend or Descend" },
      },
      required: ["vepfsIds"],
    },
    handler: listVepfsPermissions,
  },
];
