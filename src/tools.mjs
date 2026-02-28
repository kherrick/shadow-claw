/**
 * ShadowClaw — Tool definitions for the Claude API
 */

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Object} input_schema
 */

export const TOOL_DEFINITIONS = [
  {
    name: "bash",
    description:
      "Execute a command in a full Alpine Linux VM (x86). " +
      "Provides a real Linux environment with persistent filesystem. " +
      "Supports all standard Linux commands (ls, cat, grep, uptime, top, apk, etc.), " +
      "pipes (|), redirects (> >>), and shell operators (&& || ;). " +
      "Runs with root privileges inside the VM. " +
      "Uses the group workspace filesystem mounted via 9p. ",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 30, max: 240)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file from the group workspace. " +
      "Returns the full text content of the file.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the group workspace root",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file in the group workspace. " +
      "Creates the file and any intermediate directories if they don't exist. " +
      "Overwrites the file if it already exists.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the group workspace root",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories in the group workspace. " +
      "Directory names end with /. Returns sorted entries.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path relative to workspace root (default: root)",
        },
      },
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch a URL via HTTP and return the response body. " +
      "Subject to browser CORS restrictions — works with most public APIs. " +
      "Response is truncated to 100KB.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        method: {
          type: "string",
          description: "HTTP method (default: GET)",
        },
        headers: {
          type: "object",
          description: "Request headers as key-value pairs",
        },
        body: {
          type: "string",
          description: "Request body (for POST/PUT/PATCH)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "update_memory",
    description:
      "Update the MEMORY.md memory file for this group. " +
      "Use this to persist important context, user preferences, project state, " +
      "and anything the agent should remember across conversations. " +
      "This file is loaded as system context on every invocation.",
    input_schema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "New content for the MEMORY.md memory file",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "create_task",
    description:
      "Create a scheduled recurring task. The task will run automatically " +
      "on the specified schedule and send the result back to this group. " +
      "Uses cron expressions (minute hour day-of-month month day-of-week).",
    input_schema: {
      type: "object",
      properties: {
        schedule: {
          type: "string",
          description: 'Cron expression, e.g. "0 9 * * 1-5" for 9am weekdays',
        },
        prompt: {
          type: "string",
          description: "The prompt/instruction to execute on each run",
        },
      },
      required: ["schedule", "prompt"],
    },
  },
  {
    name: "javascript",
    description:
      "Execute JavaScript code in a sandboxed context and return the result. " +
      "Lighter than bash — no VM boot required. Use for calculations, " +
      "data transformations, JSON processing, etc. " +
      "Has access to standard JS built-ins but no DOM or network.",
    input_schema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript code to execute. The return value of the last expression is captured.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "list_tasks",
    description:
      "List all scheduled recurring tasks for this group. " +
      "Returns a list of tasks with their IDs, schedules, and prompts.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_task",
    description: "Update an existing scheduled task's schedule or prompt.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The unique ID of the task to update",
        },
        schedule: {
          type: "string",
          description: "New cron expression (optional)",
        },
        prompt: {
          type: "string",
          description: "New prompt/instruction (optional)",
        },
        enabled: {
          type: "boolean",
          description: "Whether the task is enabled (optional)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_task",
    description: "Delete a scheduled task by its ID.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The unique ID of the task to delete",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "enable_task",
    description: "Enable a scheduled task so it runs on its schedule.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The unique ID of the task to enable",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "disable_task",
    description: "Disable a scheduled task so it stops running.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The unique ID of the task to disable",
        },
      },
      required: ["id"],
    },
  },
];
