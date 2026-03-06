# Claude Skills - Usage Guide

## Dida365 Task Tracking

When working on complex, multi-step tasks, use the Dida365 tools to track progress in the user's 滴答清单 app.

### Workflow

1. **Starting a long task**: Call `dida_track_progress` with a task title and list of planned steps
2. **During execution**: Call `dida_update_progress` after completing each step, marking it done and adding notes
3. **Completion**: Call `dida_complete_task` when all steps are finished

### When to track

- Tasks with 3+ distinct steps
- Refactoring or migration work
- Bug investigations that span multiple files
- Any task the user explicitly asks to track

### Example

Starting a refactor task:
```
dida_track_progress({
  taskTitle: "Refactor auth module to use JWT",
  steps: [
    "Analyze current session-based auth",
    "Add JWT dependencies",
    "Implement token generation",
    "Update middleware",
    "Write tests",
    "Update documentation"
  ]
})
```

After completing a step:
```
dida_update_progress({
  taskId: "...",
  projectId: "...",
  completedSteps: ["Analyze current session-based auth"],
  notes: "Found 3 auth endpoints in routes/auth.js, using express-session"
})
```

## Setup

### Get Dida365 Access Token

1. Go to https://developer.dida365.com/manage
2. Create a new app (name: "Claude Skills", redirect: `http://localhost:3000/callback`)
3. Use the OAuth flow to get an access token
4. Set `DIDA365_ACCESS_TOKEN` in your MCP server config

### MCP Configuration

Add to your Claude config:
```json
{
  "mcpServers": {
    "sparc-skills": {
      "command": "npx",
      "args": ["github:sparc-ai/claude-skills"],
      "env": {
        "DIDA365_ACCESS_TOKEN": "your-token"
      }
    }
  }
}
```
