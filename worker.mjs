/**
 * ShadowClaw Agent Worker
 *
 * Runs in a dedicated Web Worker. Owns the tool-use loop.
 *
 * Communicates with the main thread via postMessage.
 */

import { TOOL_DEFINITIONS } from "./src/tools.mjs";
import { FETCH_MAX_RESPONSE, getProvider } from "./src/config.mjs";
import {
  buildHeaders,
  formatRequest,
  parseResponse,
  getContextLimit,
} from "./src/providers.mjs";
import {
  readGroupFile,
  writeGroupFile,
  listGroupFiles,
  setStorageRoot,
} from "./src/storage.mjs";
import { executeShell } from "./src/shell.mjs";
import { ulid } from "./src/ulid.mjs";
import "./src/types.mjs"; // Import types

// import { executeInVM, bootVM } from "./src/vm.mjs";
// // Boot the VM eagerly in the background so it's ready by the time the user
// // sends their first bash command. This avoids blocking on-demand boot.
// bootVM().catch((err) =>
//   console.warn("[Worker] Background VM boot failed:", err),
// );

/** @type {Map<string, (tasks: any[]) => void>} */
const pendingTasks = new Map();

/**
 * Main message handler
 */
self.onmessage = async (event) => {
  const { type, payload } = event.data;

  switch (type) {
    case "invoke":
      await handleInvoke(payload);
      break;
    case "compact":
      await handleCompact(payload);
      break;
    case "set-storage":
      if (payload.storageHandle) {
        setStorageRoot(payload.storageHandle);
      }
      break;
    case "task-list-response": {
      const { groupId, tasks } = payload;
      const resolve = pendingTasks.get(groupId);
      if (resolve) {
        resolve(tasks);
        pendingTasks.delete(groupId);
      }
      break;
    }
    case "cancel":
      // TODO: AbortController-based cancellation
      break;
  }
};

/**
 * Handle agent invocation with tool-use loop
 *
 * @param {{groupId: string, messages: any[], systemPrompt: string, apiKey: string, model: string, maxTokens: number, provider: string, storageHandle?: FileSystemDirectoryHandle}} payload
 *
 * @returns {Promise<void>}
 */
async function handleInvoke(payload) {
  const {
    groupId,
    messages,
    systemPrompt,
    apiKey,
    model,
    maxTokens,
    provider: providerId,
    storageHandle,
  } = payload;

  if (storageHandle) {
    setStorageRoot(storageHandle);
  }

  const provider = getProvider(providerId);
  if (!provider) {
    post({
      type: "error",
      payload: { groupId, error: `Unknown provider: ${providerId}` },
    });

    return;
  }

  /** @type {import('./src/config.mjs').ProviderConfig} */
  const typedProvider = provider;

  post({ type: "typing", payload: { groupId } });

  log(
    groupId,
    "info",
    "Starting",
    `Provider: ${typedProvider.name} · Model: ${model} · Max tokens: ${maxTokens}`,
  );

  try {
    let currentMessages = [...messages];
    let iterations = 0;
    const maxIterations = 25;
    const toolCallHistory = []; // Track exact tool calls to prevent loops

    while (iterations < maxIterations) {
      iterations++;

      const body = formatRequest(
        typedProvider,
        currentMessages,
        TOOL_DEFINITIONS,
        {
          model,
          maxTokens,
          system: systemPrompt,
        },
      );

      log(
        groupId,
        "api-call",
        `API call #${iterations}`,
        `${currentMessages.length} messages in context`,
      );

      const headers = buildHeaders(typedProvider, apiKey);
      const res = await fetch(typedProvider.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();

        throw new Error(
          `${typedProvider.name} API error ${res.status}: ${errBody}`,
        );
      }

      const rawResult = await res.json();
      const result = parseResponse(typedProvider, rawResult);

      // Emit token usage
      if (result.usage) {
        post({
          type: "token-usage",
          payload: {
            groupId,
            inputTokens: result.usage.input_tokens || 0,
            outputTokens: result.usage.output_tokens || 0,
            cacheReadTokens: result.usage.cache_read_input_tokens || 0,
            cacheCreationTokens: result.usage.cache_creation_input_tokens || 0,
            contextLimit: getContextLimit(model),
          },
        });
      }

      // Log text blocks
      for (const block of result.content) {
        if (block.type === "text" && block.text) {
          const preview =
            block.text.length > 200
              ? block.text.slice(0, 200) + "…"
              : block.text;

          log(groupId, "text", "Response text", preview);
        }
      }

      if (result.stop_reason === "tool_use") {
        // Execute tool calls
        const toolResults = [];
        for (const block of result.content) {
          if (block.type === "tool_use") {
            const inputPreview = JSON.stringify(block.input);
            const inputShort =
              inputPreview.length > 300
                ? inputPreview.slice(0, 300) + "…"
                : inputPreview;

            log(groupId, "tool-call", `Tool: ${block.name}`, inputShort);

            post({
              type: "tool-activity",
              payload: { groupId, tool: block.name, status: "running" },
            });

            // Prevent infinite loops by detecting repeated identical tool calls
            const toolCallSignature = `${block.name}:${JSON.stringify(block.input)}`;
            const timesCalled = toolCallHistory.filter(
              (s) => s === toolCallSignature,
            ).length;

            toolCallHistory.push(toolCallSignature);

            let output;
            if (timesCalled >= 3) {
              output = `SYSTEM ERROR: You have repeatedly called this tool with the exact same input (${timesCalled + 1} times). This is a rigid loop. STOP calling this tool with these arguments. Try a different approach, fix the underlying issue, or ask the user for help.`;

              console.warn(
                `[Worker] Blocked repetitive tool call:`,
                toolCallSignature,
              );
            } else {
              output = await executeTool(block.name, block.input, groupId);
            }

            const outputStr =
              typeof output === "string" ? output : JSON.stringify(output);

            const outputShort =
              outputStr.length > 500
                ? outputStr.slice(0, 500) + "…"
                : outputStr;

            log(groupId, "tool-result", `Result: ${block.name}`, outputShort);

            post({
              type: "tool-activity",
              payload: { groupId, tool: block.name, status: "done" },
            });

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content:
                typeof output === "string"
                  ? output.slice(0, 100_000)
                  : JSON.stringify(output).slice(0, 100_000),
            });
          }
        }

        // Continue conversation with tool results
        currentMessages.push({ role: "assistant", content: result.content });
        currentMessages.push({ role: "user", content: toolResults });

        post({ type: "typing", payload: { groupId } });
      } else {
        // Final response
        const text = result.content
          .filter((/** @type {any} */ b) => b.type === "text")
          .map((/** @type {any} */ b) => b.text)
          .join("");

        const cleaned = text
          .replace(/<internal>[\s\S]*?<\/internal>/g, "")
          .trim();

        post({
          type: "response",
          payload: { groupId, text: cleaned || "(no response)" },
        });

        return;
      }
    }

    // Max iterations reached
    post({
      type: "response",
      payload: {
        groupId,
        text: "⚠️ Reached maximum tool-use iterations (25). Stopping to avoid excessive API usage.",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: "error", payload: { groupId, error: message } });
  }
}

/**
 * Handle context compaction
 * @param {{groupId: string, messages: any[], systemPrompt: string, apiKey: string, model: string, maxTokens: number, provider: string, storageHandle?: FileSystemDirectoryHandle}} payload
 * @returns {Promise<void>}
 */
async function handleCompact(payload) {
  const {
    groupId,
    messages,
    systemPrompt,
    apiKey,
    model,
    maxTokens,
    provider: providerId,
    storageHandle,
  } = payload;

  if (storageHandle) {
    setStorageRoot(storageHandle);
  }

  const provider = getProvider(providerId);
  if (!provider) {
    post({
      type: "error",
      payload: { groupId, error: `Unknown provider: ${providerId}` },
    });

    return;
  }
  /** @type {import('./src/config.mjs').ProviderConfig} */
  const typedProvider = provider;

  post({ type: "typing", payload: { groupId } });
  log(
    groupId,
    "info",
    "Compacting context",
    `Summarizing ${messages.length} messages`,
  );

  try {
    const compactSystemPrompt = [
      systemPrompt,
      "",
      "## COMPACTION TASK",
      "",
      "The conversation context is getting large. Produce a concise summary of the conversation so far.",
      "Include key facts, decisions, user preferences, and any important context.",
      "The summary will replace the full conversation history to stay within token limits.",
      "Be thorough but concise — aim for the essential information only.",
    ].join("\n");

    const compactMessages = [
      ...messages,
      {
        role: "user",
        content:
          "Please provide a concise summary of our entire conversation so far. Include all key facts, decisions, code discussed, and important context. This summary will replace the full history.",
      },
    ];

    const body = formatRequest(typedProvider, compactMessages, [], {
      model,
      maxTokens: Math.min(maxTokens, 4096),
      system: compactSystemPrompt,
    });

    const headers = buildHeaders(typedProvider, apiKey);
    const res = await fetch(typedProvider.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();

      throw new Error(
        `${typedProvider.name} API error ${res.status}: ${errBody}`,
      );
    }

    const rawResult = await res.json();
    const result = parseResponse(typedProvider, rawResult);
    const summary = result.content
      .filter((/** @type {any} */ b) => b.type === "text")
      .map((/** @type {any} */ b) => b.text)
      .join("");

    log(
      groupId,
      "info",
      "Compaction complete",
      `Summary: ${summary.length} chars`,
    );

    post({ type: "compact-done", payload: { groupId, summary } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({
      type: "error",
      payload: { groupId, error: `Compaction failed: ${message}` },
    });
  }
}

/**
 * Execute a tool
 *
 * @param {string} name
 * @param {Record<string, any>} input
 * @param {string} groupId
 *
 * @returns {Promise<string>}
 */
async function executeTool(name, input, groupId) {
  try {
    switch (name) {
      case "bash": {
        // // Try VM first — executeInVM will attempt boot if needed
        // const vmResult = await executeInVM(
        //   input.command,
        //   Math.min(input.timeout || 30, 240),
        // );
        //
        // // If VM booted successfully, return its output
        // if (!vmResult.startsWith("Error: WebVM is not available")) {
        //   return vmResult;
        // }

        // VM unavailable — fall back to JS shell emulator
        const shellResult = await executeShell(
          input.command,
          groupId,
          {},
          Math.min(input.timeout || 30, 240),
        );
        let shellOutput = shellResult.stdout || "";
        if (shellResult.stderr)
          shellOutput += (shellOutput ? "\n" : "") + shellResult.stderr;
        if (shellResult.exitCode !== 0 && !shellOutput)
          shellOutput = `[exit code: ${shellResult.exitCode}]`;
        return shellOutput || "(no output)";
      }

      case "read_file":
        return await readGroupFile(groupId, input.path);

      case "write_file":
        await writeGroupFile(groupId, input.path, input.content);

        return `Written ${input.content.length} bytes to ${input.path}`;

      case "list_files": {
        const entries = await listGroupFiles(groupId, input.path || ".");

        return entries.length > 0 ? entries.join("\n") : "(empty directory)";
      }

      case "fetch_url": {
        try {
          const fetchRes = await fetch(input.url, {
            method: input.method || "GET",
            headers: input.headers || {},
            body: input.body,
          });

          const rawText = await fetchRes.text();
          const contentType = fetchRes.headers.get("content-type") || "";
          const status = `[HTTP ${fetchRes.status} ${fetchRes.statusText}]\n`;

          let body = rawText;
          if (
            contentType.includes("html") ||
            rawText.trimStart().startsWith("<")
          ) {
            body = stripHtml(rawText);
          }

          if (!fetchRes.ok) {
            return `${status}Error fetching URL. Content preview:\n${body.slice(0, 1000)}`;
          }

          return status + body.slice(0, FETCH_MAX_RESPONSE);
        } catch (fetchErr) {
          const errMsg =
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          return `Network Error: Failed to fetch ${input.url}.\nReason: ${errMsg}\nCheck if the URL is correct and the server is reachable. If this is a CORS issue, it may be blocked by the browser.`;
        }
      }

      case "update_memory":
        await writeGroupFile(groupId, "MEMORY.md", input.content);

        return "Memory updated successfully.";

      case "create_task": {
        const taskData = {
          id: ulid(),
          groupId,
          schedule: input.schedule,
          prompt: input.prompt,
          enabled: true,
          lastRun: null,
          createdAt: Date.now(),
        };

        post({ type: "task-created", payload: { task: taskData } });

        return `Task created successfully.\nSchedule: ${taskData.schedule}\nPrompt: ${taskData.prompt}`;
      }

      case "javascript": {
        try {
          const code = input.code;
          const result = (0, eval)(`"use strict";\n${code}`);

          if (result === undefined) return "(no return value)";
          if (result === null) return "null";
          if (typeof result === "object") {
            try {
              return JSON.stringify(result, null, 2);
            } catch {
              /* fall through */
            }
          }

          return String(result);
        } catch (err) {
          return `JavaScript error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case "list_tasks": {
        return new Promise((resolve) => {
          pendingTasks.set(groupId, (tasks) => {
            if (tasks.length === 0) resolve("No tasks found for this group.");
            const list = tasks
              .map(
                (t) =>
                  `[ID: ${t.id}] Schedule: ${t.schedule}, Prompt: ${t.prompt}, Enabled: ${t.enabled}`,
              )
              .join("\n");

            resolve(list);
          });

          post({ type: "task-list-request", payload: { groupId } });
        });
      }

      case "update_task": {
        const tasks = await new Promise((resolve) => {
          pendingTasks.set(groupId, resolve);

          post({ type: "task-list-request", payload: { groupId } });
        });

        const task = tasks.find((/** @type {any} */ t) => t.id === input.id);

        if (!task) {
          return `Error: Task with ID ${input.id} not found.`;
        }

        if (input.schedule) task.schedule = input.schedule;
        if (input.prompt) task.prompt = input.prompt;
        if (input.enabled !== undefined) task.enabled = !!input.enabled;

        post({ type: "update-task", payload: { task } });

        return `Task ${input.id} updated successfully.`;
      }

      case "enable_task": {
        const tasks = await new Promise((resolve) => {
          pendingTasks.set(groupId, resolve);

          post({ type: "task-list-request", payload: { groupId } });
        });

        const task = tasks.find((/** @type {any} */ t) => t.id === input.id);
        if (!task) return `Error: Task with ID ${input.id} not found.`;

        task.enabled = true;

        post({ type: "update-task", payload: { task } });

        return `Task ${input.id} enabled successfully.`;
      }

      case "disable_task": {
        const tasks = await new Promise((resolve) => {
          pendingTasks.set(groupId, resolve);

          post({ type: "task-list-request", payload: { groupId } });
        });

        const task = tasks.find((/** @type {any} */ t) => t.id === input.id);
        if (!task) return `Error: Task with ID ${input.id} not found.`;

        task.enabled = false;

        post({ type: "update-task", payload: { task } });

        return `Task ${input.id} disabled successfully.`;
      }

      case "delete_task": {
        post({ type: "delete-task", payload: { id: input.id } });

        return `Task ${input.id} deleted successfully.`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Post a message to the main thread
 *
 * @param {any} message
 *
 * @private
 */
function post(message) {
  self.postMessage(message);
}

/**
 * Extract readable text from HTML
 *
 * @param {string} html
 *
 * @returns {string}
 */
function stripHtml(html) {
  let text = html;
  text = text.replace(
    /<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );

  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "");

  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();

  return text;
}

/**
 * Log a message
 *
 * @param {string} groupId
 * @param {string} level
 * @param {string} label
 * @param {string} [message]
 */
function log(groupId, level, label, message) {
  post({
    type: "thinking-log",
    payload: { groupId, level, timestamp: Date.now(), label, message },
  });
}
