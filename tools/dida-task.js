/**
 * Dida365 (滴答清单) task management tools
 *
 * API Base: https://api.dida365.com/open/v1
 * Auth: Bearer token (set DIDA365_ACCESS_TOKEN env var)
 *
 * Use case: Track progress of long-running Claude tasks
 * by creating/updating tasks under a dedicated "Claude" project.
 *
 * The Open API does NOT support assigning projects to folders (groupId).
 * User should manually drag the "Claude" project into their desired folder once.
 */

const BASE_URL = "https://api.dida365.com/open/v1";

function getToken() {
  const token = process.env.DIDA365_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "DIDA365_ACCESS_TOKEN not set. Get one at https://developer.dida365.com/manage"
    );
  }
  return token;
}

async function api(method, path, body) {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dida365 API ${method} ${path} failed (${res.status}): ${text}`);
  }
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return res.json();
  }
  return null;
}

// --- Tool implementations ---

async function listProjects() {
  const projects = await api("GET", "/project");
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    groupId: p.groupId,
    color: p.color,
    kind: p.kind,
  }));
}

async function getProjectTasks(projectId) {
  const data = await api("GET", `/project/${projectId}/data`);
  return {
    project: { id: data.project.id, name: data.project.name },
    tasks: (data.tasks || []).map((t) => ({
      id: t.id,
      title: t.title,
      content: t.content,
      desc: t.desc,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      items: t.items,
      tags: t.tags,
      kind: t.kind,
    })),
  };
}

async function createTask({ projectId, title, content, desc, priority, dueDate, items }) {
  const body = { projectId, title };
  if (content) body.content = content;
  if (desc) body.desc = desc;
  if (priority !== undefined) body.priority = priority;
  if (dueDate) body.dueDate = dueDate;
  if (items) body.items = items;
  return api("POST", "/task", body);
}

async function updateTask(taskId, updates) {
  // API requires id and projectId in body
  const body = { id: taskId, ...updates };
  return api("POST", `/task/${taskId}`, body);
}

async function completeTask(projectId, taskId) {
  await api("POST", `/project/${projectId}/task/${taskId}/complete`);
  return { success: true, taskId };
}

async function deleteTask(projectId, taskId) {
  // Correct endpoint: DELETE /open/v1/project/{projectId}/task/{taskId}
  await api("DELETE", `/project/${projectId}/task/${taskId}`);
  return { success: true, taskId };
}

async function moveTask(fromProjectId, toProjectId, taskId) {
  return api("POST", "/task/move", [{ fromProjectId, toProjectId, taskId }]);
}

async function listCompletedTasks({ projectIds, startDate, endDate }) {
  const body = {};
  if (projectIds) body.projectIds = projectIds;
  if (startDate) body.startDate = startDate;
  if (endDate) body.endDate = endDate;
  return api("POST", "/task/completed", body);
}

async function filterTasks({ projectIds, startDate, endDate, priority, tag, status }) {
  const body = {};
  if (projectIds) body.projectIds = projectIds;
  if (startDate) body.startDate = startDate;
  if (endDate) body.endDate = endDate;
  if (priority) body.priority = priority;
  if (tag) body.tag = tag;
  if (status) body.status = status;
  return api("POST", "/task/filter", body);
}

// Find or create the "Claude" project for tracking
async function ensureClaudeProject() {
  const projects = await api("GET", "/project");
  let claude = projects.find(
    (p) => p.name === "Claude" || p.name === "🤖Claude" || p.name === "🤖 Claude"
  );
  if (!claude) {
    claude = await api("POST", "/project", {
      name: "🤖 Claude",
      kind: "TASK",
      viewMode: "list",
    });
  }
  return claude;
}

// Pick an emoji comment prefix based on keywords in the title
// Only used in task content/notes, NOT in the title itself
function pickEmoji(title) {
  const t = title.toLowerCase();
  const rules = [
    [/fix|bug|issue|error|crash/, "🐛"],
    [/refactor|clean|restructure/, "🔧"],
    [/test|spec|coverage/, "🧪"],
    [/deploy|ci|cd|pipeline|release/, "🚀"],
    [/doc|readme|guide|wiki/, "📝"],
    [/auth|login|security|token/, "🔐"],
    [/api|endpoint|route/, "🔌"],
    [/ui|css|style|design|layout/, "🎨"],
    [/perf|speed|optim|cache/, "⚡"],
    [/db|database|migration|schema/, "🗄️"],
    [/config|setup|init|install/, "⚙️"],
    [/search|find|query/, "🔍"],
    [/ai|model|ml|train/, "🧠"],
    [/chat|message|notification/, "💬"],
    [/file|upload|download|storage/, "📦"],
    [/monitor|log|metric|alert/, "📊"],
    [/network|http|request|socket/, "🌐"],
  ];
  for (const [pattern, emoji] of rules) {
    if (pattern.test(t)) return emoji;
  }
  return "📋";
}

/**
 * Start tracking a Claude task.
 * Creates a task with subtask checklist items under the "Claude" project.
 * Task title is auto-prefixed with an emoji based on keywords.
 *
 * Structure in Dida365:
 *   📂 Claude folder (user drags project in once)
 *   └── 🤖 Claude (project)
 *       ├── 🔧 Refactor auth module        ← task with emoji
 *       │   ├── ☐ Analyze current code      ← checklist items
 *       │   └── ☐ Write tests
 *       ├── 🚀 Setup CI pipeline
 *       │   └── ☐ Configure Actions
 *       └── 🐛 Fix payment bug
 *           └── ☐ Reproduce issue
 */
async function trackProgress({ taskTitle, steps }) {
  const project = await ensureClaudeProject();
  const emoji = pickEmoji(taskTitle);
  const items = steps.map((step, i) => ({
    title: step,
    status: 0,
    sortOrder: i,
  }));
  const task = await createTask({
    projectId: project.id,
    title: taskTitle,
    content: `${emoji} Tracked by Claude at ${new Date().toISOString()}`,
    priority: 3,
    items,
  });
  return {
    projectId: project.id,
    projectName: project.name,
    taskId: task.id,
    title: task.title,
    steps: items.map((it) => it.title),
  };
}

/**
 * Update progress: mark subtask steps as done and optionally add notes.
 */
async function updateProgress({ taskId, projectId, completedSteps, notes }) {
  const data = await api("GET", `/project/${projectId}/data`);
  const task = (data.tasks || []).find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in project ${projectId}`);

  const items = (task.items || []).map((item) => {
    if (completedSteps && completedSteps.includes(item.title)) {
      return { ...item, status: 1 };
    }
    return item;
  });

  const updates = { projectId, items };
  if (notes) {
    updates.content = (task.content || "") + `\n\n[${new Date().toISOString()}] ${notes}`;
  }

  return updateTask(taskId, updates);
}

// --- Tool definitions for MCP registration ---

export const tools = [
  {
    name: "dida_list_projects",
    description: "List all projects/lists in Dida365 (滴答清单)",
    inputSchema: { type: "object", properties: {} },
    handler: listProjects,
  },
  {
    name: "dida_get_project_tasks",
    description:
      "Get all tasks in a Dida365 project, including subtask checklist items",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
      },
      required: ["projectId"],
    },
    handler: ({ projectId }) => getProjectTasks(projectId),
  },
  {
    name: "dida_create_task",
    description:
      "Create a new task in Dida365. Can include subtask checklist items.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Target project ID" },
        title: { type: "string", description: "Task title" },
        content: { type: "string", description: "Task content/notes" },
        desc: { type: "string", description: "Description of checklist" },
        priority: {
          type: "number",
          description: "0=none, 1=low, 3=medium, 5=high",
        },
        dueDate: {
          type: "string",
          description: "Due date in yyyy-MM-dd'T'HH:mm:ssZ format",
        },
        items: {
          type: "array",
          description: "Subtask checklist items",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              status: { type: "number", description: "0=normal, 1=completed" },
            },
          },
        },
      },
      required: ["projectId", "title"],
    },
    handler: createTask,
  },
  {
    name: "dida_update_task",
    description: "Update an existing task in Dida365 (title, content, status, items, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to update" },
        projectId: { type: "string", description: "Project ID the task belongs to (required)" },
        title: { type: "string" },
        content: { type: "string" },
        priority: { type: "number" },
        dueDate: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              status: { type: "number" },
            },
          },
        },
      },
      required: ["taskId", "projectId"],
    },
    handler: ({ taskId, ...updates }) => updateTask(taskId, updates),
  },
  {
    name: "dida_complete_task",
    description: "Mark a task as completed in Dida365",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        taskId: { type: "string", description: "Task ID to complete" },
      },
      required: ["projectId", "taskId"],
    },
    handler: ({ projectId, taskId }) => completeTask(projectId, taskId),
  },
  {
    name: "dida_delete_task",
    description: "Delete a task from Dida365",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        taskId: { type: "string", description: "Task ID to delete" },
      },
      required: ["projectId", "taskId"],
    },
    handler: ({ projectId, taskId }) => deleteTask(projectId, taskId),
  },
  {
    name: "dida_move_task",
    description: "Move a task from one project to another in Dida365",
    inputSchema: {
      type: "object",
      properties: {
        fromProjectId: { type: "string", description: "Source project ID" },
        toProjectId: { type: "string", description: "Destination project ID" },
        taskId: { type: "string", description: "Task ID to move" },
      },
      required: ["fromProjectId", "toProjectId", "taskId"],
    },
    handler: ({ fromProjectId, toProjectId, taskId }) =>
      moveTask(fromProjectId, toProjectId, taskId),
  },
  {
    name: "dida_list_completed",
    description: "List completed tasks, optionally filtered by project and date range",
    inputSchema: {
      type: "object",
      properties: {
        projectIds: { type: "array", items: { type: "string" }, description: "Project IDs to filter" },
        startDate: { type: "string", description: "Start date (yyyy-MM-dd'T'HH:mm:ssZ)" },
        endDate: { type: "string", description: "End date (yyyy-MM-dd'T'HH:mm:ssZ)" },
      },
    },
    handler: listCompletedTasks,
  },
  {
    name: "dida_filter_tasks",
    description: "Filter tasks by project, date, priority, tags, and status",
    inputSchema: {
      type: "object",
      properties: {
        projectIds: { type: "array", items: { type: "string" } },
        startDate: { type: "string" },
        endDate: { type: "string" },
        priority: { type: "array", items: { type: "number" }, description: "0=none, 1=low, 3=medium, 5=high" },
        tag: { type: "array", items: { type: "string" } },
        status: { type: "array", items: { type: "number" }, description: "0=open, 2=completed" },
      },
    },
    handler: filterTasks,
  },
  {
    name: "dida_track_progress",
    description:
      'Start tracking a Claude task. Creates a task with emoji and subtask steps under the "Claude" project. Use this when starting a complex, multi-step task.',
    inputSchema: {
      type: "object",
      properties: {
        taskTitle: {
          type: "string",
          description: "Main task title, e.g. 'Refactor auth module'",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description:
            "Ordered list of steps, e.g. ['Analyze current code', 'Write tests', 'Implement changes']",
        },
      },
      required: ["taskTitle", "steps"],
    },
    handler: trackProgress,
  },
  {
    name: "dida_update_progress",
    description:
      "Update progress on a tracked Claude task. Mark steps as completed and add notes.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID from dida_track_progress" },
        projectId: { type: "string", description: "Project ID (Claude project)" },
        completedSteps: {
          type: "array",
          items: { type: "string" },
          description: "Step titles to mark as completed",
        },
        notes: {
          type: "string",
          description: "Progress notes to append",
        },
      },
      required: ["taskId", "projectId"],
    },
    handler: updateProgress,
  },
];
