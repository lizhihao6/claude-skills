/**
 * Dida365 (滴答清单) task management tools
 *
 * API Base: https://api.dida365.com/open/v1
 * Auth: Bearer token (set DIDA365_ACCESS_TOKEN env var)
 *
 * Use case: Track progress of long-running Claude tasks
 * by creating/updating tasks under a dedicated project.
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
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      items: t.items,
      tags: t.tags,
    })),
  };
}

async function createTask({ projectId, title, content, priority, dueDate, items }) {
  const body = { projectId, title };
  if (content) body.content = content;
  if (priority !== undefined) body.priority = priority;
  if (dueDate) body.dueDate = dueDate;
  if (items) body.items = items; // subtask checklist items
  return api("POST", "/task", body);
}

async function updateTask(taskId, updates) {
  return api("POST", `/task/${taskId}`, updates);
}

async function completeTask(projectId, taskId) {
  await api("POST", `/project/${projectId}/task/${taskId}/complete`);
  return { success: true, taskId };
}

async function deleteTask(projectId, taskId) {
  await api("DELETE", `/task/${projectId}/${taskId}`);
  return { success: true, taskId };
}

// Claude folder groupId (set via DIDA365_GROUP_ID env, or auto-detect)
function getGroupId() {
  return process.env.DIDA365_GROUP_ID || null;
}

// Find the Claude folder's groupId by scanning existing projects
async function findClaudeFolderGroupId() {
  const envId = getGroupId();
  if (envId) return envId;
  // Auto-detect: look for projects in a group that looks like a Claude folder
  const projects = await api("GET", "/project");
  const claudeProject = projects.find(
    (p) => p.groupId && /claude/i.test(p.name)
  );
  if (claudeProject) return claudeProject.groupId;
  // Fallback: return null (project will be created at top level)
  return null;
}

// Pick an emoji based on keywords in the title
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
  return "🤖";
}

/**
 * High-level: Start tracking a Claude task.
 * Creates a NEW project (清单) inside the Claude folder for each tracked task.
 * Each project gets an auto-selected emoji and contains tasks as checklist steps.
 *
 * Structure in Dida365:
 *   📂 Claude (folder/清单组)
 *   ├── 🔧 Refactor auth module        ← project per task
 *   │   ├── ☐ Analyze current code      ← task checklist items
 *   │   ├── ☐ Write tests
 *   │   └── ☐ Implement changes
 *   ├── 🚀 Setup CI pipeline
 *   │   └── ☐ Configure Actions
 *   └── 🐛 Fix payment bug
 *       └── ☐ Reproduce issue
 */
async function trackProgress({ taskTitle, steps }) {
  const groupId = await findClaudeFolderGroupId();
  const emoji = pickEmoji(taskTitle);
  const projectName = `${emoji} ${taskTitle}`;

  // Create a new project inside the Claude folder
  const projectBody = { name: projectName };
  if (groupId) projectBody.groupId = groupId;
  const project = await api("POST", "/project", projectBody);

  // Create a single task with checklist items for the steps
  const items = steps.map((step, i) => ({
    title: step,
    status: 0,
    sortOrder: i,
  }));
  const task = await createTask({
    projectId: project.id,
    title: taskTitle,
    content: `Tracked by Claude at ${new Date().toISOString()}`,
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
 * Update progress: mark a subtask step as done and optionally add notes.
 */
async function updateProgress({ taskId, projectId, completedSteps, notes }) {
  const data = await api("GET", `/project/${projectId}/data`);
  const task = (data.tasks || []).find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in project ${projectId}`);

  const items = (task.items || []).map((item) => {
    if (completedSteps && completedSteps.includes(item.title)) {
      return { ...item, status: 1 }; // 1 = completed
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
        content: { type: "string", description: "Task description/notes" },
        priority: {
          type: "number",
          description: "0=none, 1=low, 3=medium, 5=high",
        },
        dueDate: {
          type: "string",
          description: "Due date in ISO 8601 format",
        },
        items: {
          type: "array",
          description: "Subtask checklist items",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              status: {
                type: "number",
                description: "0=uncompleted, 1=completed",
              },
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
        projectId: { type: "string", description: "Project ID the task belongs to" },
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
      required: ["taskId"],
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
    name: "dida_track_progress",
    description:
      'Start tracking a Claude task session. Creates a task with subtask steps under the "Claude" project. Use this when starting a complex, multi-step task.',
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
