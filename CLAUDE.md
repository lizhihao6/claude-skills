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

### 1. Install CLI Tools

#### Volcengine ML Platform CLI (`volc`)

Used for managing distributed training tasks (submit, cancel, logs, etc.).

```bash
# One-liner install (Linux/macOS)
curl -s https://ml-platform-public-examples-cn-beijing.tos-cn-beijing.volces.com/cli-binary/install.sh | bash

# Installs to ~/.volc/bin/volc
# Source the profile to add to PATH:
source ~/.volc/.profile

# Configure credentials
volc configure
# Enter: Access Key, Secret Key, Region (e.g. cn-beijing)

# Verify
volc version
```

#### Volcengine Cloud CLI (`ve`)

Used for calling any Volcengine OpenAPI service (ECS, VPC, IAM, etc.).

```bash
# Download from GitHub releases
# https://github.com/volcengine/volcengine-cli/releases
curl -L -o ve https://github.com/volcengine/volcengine-cli/releases/latest/download/volcengine-cli-linux-amd64
chmod +x ve
mkdir -p ~/.local/bin && mv ve ~/.local/bin/

# Configure credentials
ve configure set --profile default \
  --region cn-shanghai \
  --access-key <YOUR_ACCESS_KEY> \
  --secret-key <YOUR_SECRET_KEY>

# Verify
ve --version
```

### 2. Get Dida365 Access Token

1. Go to https://developer.dida365.com/manage
2. Create a new app (name: "Claude Skills", redirect: `http://localhost:3000/callback`)
3. Use the OAuth flow to get an access token
4. Set `DIDA365_ACCESS_TOKEN` in your MCP server config

### 3. MCP Configuration

Add to your Claude config:
```json
{
  "mcpServers": {
    "claude-skills": {
      "command": "npx",
      "args": ["github:lizhihao6/claude-skills"],
      "env": {
        "DIDA365_ACCESS_TOKEN": "your-token",
        "VOLC_CLI_PATH": "~/.volc/bin/volc",
        "VE_CLI_PATH": "~/.local/bin/ve"
      }
    }
  }
}
```
