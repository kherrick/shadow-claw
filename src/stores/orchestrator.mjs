// @ts-ignore
import { Signal } from "signal-polyfill";
import { DEFAULT_GROUP_ID } from "../config.mjs";
import {
  getRecentMessages,
  getAllTasks,
  saveTask,
  deleteTask,
} from "../db.mjs";
import {
  listGroupFiles,
  requestStorageAccess,
  getStorageStatus,
} from "../storage.mjs";

/** @typedef {import('../orchestrator.mjs').Orchestrator} Orchestrator */
/** @typedef {import('../types.mjs').StoredMessage} StoredMessage */
/** @typedef {import('../types.mjs').ThinkingLogEntry} ThinkingLogEntry */
/** @typedef {import('../types.mjs').ToolActivity} ToolActivity */
/** @typedef {import('../types.mjs').TokenUsage} TokenUsage */

/**
 * @typedef {Object} OrchestratorStoreState
 *
 * @property {StoredMessage[]} messages
 * @property {boolean} isTyping
 * @property {ToolActivity|null} toolActivity
 * @property {ThinkingLogEntry[]} activityLog
 * @property {'idle'|'thinking'|'responding'|'error'} state
 * @property {TokenUsage|null} tokenUsage
 * @property {string|null} error
 * @property {string} activeGroupId
 * @property {boolean} ready
 * @property {string[]} files
 * @property {string} currentPath
 */

export class OrchestratorStore {
  constructor() {
    /** @type {Signal.State<StoredMessage[]>} */
    this._messages = new Signal.State([]);
    /** @type {Signal.State<boolean>} */
    this._isTyping = new Signal.State(false);
    /** @type {Signal.State<import('../storage.mjs').StorageStatus|null>} */
    this._storageStatus = new Signal.State(null);
    /** @type {Signal.State<ToolActivity|null>} */
    this._toolActivity = new Signal.State(null);
    /** @type {Signal.State<ThinkingLogEntry[]>} */
    this._activityLog = new Signal.State([]);
    /** @type {Signal.State<'idle'|'thinking'|'responding'|'error'>} */
    this._state = new Signal.State("idle");
    /** @type {Signal.State<TokenUsage|null>} */
    this._tokenUsage = new Signal.State(null);
    /** @type {Signal.State<string|null>} */
    this._error = new Signal.State(null);
    /** @type {Signal.State<string>} */
    this._activeGroupId = new Signal.State(DEFAULT_GROUP_ID);
    /** @type {Signal.State<boolean>} */
    this._ready = new Signal.State(false);
    /** @type {Signal.State<import('../types.mjs').Task[]>} */
    this._tasks = new Signal.State([]);
    /** @type {Signal.State<string[]>} */
    this._files = new Signal.State([]);
    /** @type {Signal.State<string>} */
    this._currentPath = new Signal.State(".");

    /** @type {Orchestrator|null} */
    this.orchestrator = null;
  }

  // --- Getters for reactive state ---
  get messages() {
    return this._messages.get();
  }
  get isTyping() {
    return this._isTyping.get();
  }
  get toolActivity() {
    return this._toolActivity.get();
  }
  get activityLog() {
    return this._activityLog.get();
  }
  get state() {
    return this._state.get();
  }
  get tokenUsage() {
    return this._tokenUsage.get();
  }
  get error() {
    return this._error.get();
  }
  get activeGroupId() {
    return this._activeGroupId.get();
  }
  get ready() {
    return this._ready.get();
  }
  get tasks() {
    return this._tasks.get();
  }
  get files() {
    return this._files.get();
  }
  get currentPath() {
    return this._currentPath.get();
  }
  get storageStatus() {
    return this._storageStatus.get();
  }

  /**
   * Initialize the store with an Orchestrator instance
   * @param {Orchestrator} orch
   * @returns {Promise<void>}
   */
  async init(orch) {
    this.orchestrator = orch;

    // Subscribe to orchestrator events
    orch.events.on("message", (/** @type {StoredMessage} */ msg) => {
      this._messages.set([...this._messages.get(), msg]);
    });

    orch.events.on("typing", (/** @type {{typing: boolean}} */ { typing }) => {
      this._isTyping.set(typing);
    });

    orch.events.on(
      "tool-activity",
      (/** @type {{tool: string, status: string}} */ { tool, status }) => {
        this._toolActivity.set(status === "running" ? { tool, status } : null);
      },
    );

    orch.events.on("thinking-log", (/** @type {ThinkingLogEntry} */ entry) => {
      // Reset log when a new invocation starts
      if (entry.level === "info" && entry.label === "Starting") {
        this._activityLog.set([entry]);
      } else {
        this._activityLog.set([...this._activityLog.get(), entry]);
      }
    });

    orch.events.on("state-change", (/** @type {string} */ state) => {
      this._state.set(state);
      if (state === "idle") {
        this._toolActivity.set(null);
      }
    });

    orch.events.on("error", (/** @type {{error: string}} */ { error }) => {
      this._error.set(error);
      this._state.set("error");
    });

    orch.events.on("session-reset", () => {
      this._messages.set([]);
      this._activityLog.set([]);
      this._tokenUsage.set(null);
      this._toolActivity.set(null);
      this._isTyping.set(false);
      this._state.set("idle");
    });

    orch.events.on("context-compacted", () => {
      this.loadHistory();
    });

    orch.events.on("token-usage", (/** @type {TokenUsage} */ usage) => {
      this._tokenUsage.set(usage);
    });

    orch.events.on("ready", () => {
      this._ready.set(true);
    });

    orch.events.on("task-change", () => {
      this.loadTasks();
    });

    orch.events.on("file-change", () => {
      this.loadFiles();
    });

    // Load initial history, tasks, and files
    await Promise.all([this.loadHistory(), this.loadTasks(), this.loadFiles()]);
    this._ready.set(true);
  }

  /**
   * Send a message
   * @param {string} text
   * @returns {void}
   */
  sendMessage(text) {
    this.orchestrator?.submitMessage?.(text, this._activeGroupId.get());
  }

  /**
   * Run a task by prompt
   * @param {string} prompt
   * @returns {void}
   */
  runTask(prompt) {
    this.sendMessage(prompt);
  }

  /**
   * Start a new session
   * @returns {Promise<void>}
   */
  async newSession() {
    return this.orchestrator?.newSession?.(this._activeGroupId.get());
  }

  /**
   * Compact context
   * @returns {Promise<void>}
   */
  async compactContext() {
    return this.orchestrator?.compactContext?.(this._activeGroupId.get());
  }

  /**
   * Clear error
   */
  clearError() {
    this._error.set(null);
    if (this._state.get() === "error") {
      this._state.set("idle");
    }
  }

  /**
   * Load message history
   * @returns {Promise<void>}
   */
  async loadHistory() {
    const msgs = await getRecentMessages(this._activeGroupId.get(), 200);
    this._messages.set(msgs);
  }

  /**
   * Load tasks
   * @returns {Promise<void>}
   */
  async loadTasks() {
    const allTasks = await getAllTasks();
    const currentGroupId = this._activeGroupId.get();
    this._tasks.set(allTasks.filter((t) => t.groupId === currentGroupId));
  }

  /**
   * Toggle a task
   * @param {import('../types.mjs').Task} task
   * @param {boolean} enabled
   */
  async toggleTask(task, enabled) {
    const updatedTask = { ...task, enabled };
    await saveTask(updatedTask);
    await this.loadTasks();
  }

  /**
   * Delete a task
   * @param {string} id
   */
  async deleteTask(id) {
    await deleteTask(id);
    await this.loadTasks();
  }

  /**
   * Clear all tasks for the current group
   * @returns {Promise<void>}
   */
  async clearAllTasks() {
    const allTasks = await getAllTasks();
    const currentGroupId = this._activeGroupId.get();
    const groupTasks = allTasks.filter((t) => t.groupId === currentGroupId);
    for (const task of groupTasks) {
      await deleteTask(task.id);
    }
    await this.loadTasks();
  }

  /**
   * Get all tasks for backup
   * @returns {import('../types.mjs').Task[]}
   */
  getTasksForBackup() {
    return this._tasks.get();
  }

  /**
   * Restore tasks from backup
   * @param {import('../types.mjs').Task[]} tasks
   * @returns {Promise<void>}
   */
  async restoreTasksFromBackup(tasks) {
    // First, clear all existing tasks
    await this.clearAllTasks();

    const currentGroupId = this._activeGroupId.get();
    // Save each task with current group ID and new IDs
    for (const task of tasks) {
      const taskToSave = {
        ...task,
        groupId: currentGroupId,
        id: crypto.randomUUID
          ? crypto.randomUUID()
          : `task-${Date.now()}-${Math.random()}`,
      };
      await saveTask(taskToSave);
    }
    await this.loadTasks();
  }

  /**
   * Load files
   * @returns {Promise<void>}
   */
  async loadFiles() {
    const groupId = this._activeGroupId.get();
    const currentPath = this._currentPath.get();
    try {
      this._storageStatus.set(await getStorageStatus());
      const files = await listGroupFiles(groupId, currentPath);
      this._files.set(files);
    } catch (err) {
      console.error("Failed to load files in store:", err);
    }
  }

  /**
   * Request storage access
   * @returns {Promise<void>}
   */
  async grantStorageAccess() {
    try {
      await requestStorageAccess();
      await this.loadFiles(); // Refresh files and status after granting access
    } catch (err) {
      console.error("Failed to grant storage access:", err);
    }
  }

  /**
   * Navigate into a folder
   * @param {string} folderName
   * @returns {Promise<void>}
   */
  async navigateIntoFolder(folderName) {
    const currentPath = this._currentPath.get();
    const newPath =
      currentPath === "."
        ? folderName.replace(/\/$/, "")
        : `${currentPath}/${folderName.replace(/\/$/, "")}`;
    this._currentPath.set(newPath);
    await this.loadFiles();
  }

  /**
   * Navigate back to parent folder
   * @returns {Promise<void>}
   */
  async navigateBackFolder() {
    const currentPath = this._currentPath.get();
    if (currentPath === ".") return;

    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const newPath = parts.length === 0 ? "." : parts.join("/");
    this._currentPath.set(newPath);
    await this.loadFiles();
  }

  /**
   * Reset to root folder
   * @returns {Promise<void>}
   */
  async resetToRootFolder() {
    this._currentPath.set(".");
    await this.loadFiles();
  }

  /**
   * Set active group
   * @param {string} groupId
   */
  setActiveGroup(groupId) {
    this._activeGroupId.set(groupId);
    this._messages.set([]);
    this._activityLog.set([]);
    this._error.set(null);
    this._isTyping.set(false);
    this._toolActivity.set(null);
    this._currentPath.set(".");
    this.loadHistory();
    this.loadTasks();
    this.loadFiles();
  }

  /**
   * Get current state
   * @returns {OrchestratorStoreState}
   */
  getState() {
    return {
      messages: this.messages,
      isTyping: this.isTyping,
      toolActivity: this.toolActivity,
      activityLog: this.activityLog,
      state: this.state,
      tokenUsage: this.tokenUsage,
      error: this.error,
      activeGroupId: this.activeGroupId,
      ready: this.ready,
      files: this.files,
      currentPath: this.currentPath,
    };
  }
}

export const orchestratorStore = new OrchestratorStore();
