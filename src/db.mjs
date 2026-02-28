/**
 * ShadowClaw — IndexedDB database layer
 */

import { DB_NAME, DB_VERSION } from "./config.mjs";
import "./types.mjs"; // Import types

/** @type {IDBDatabase|null} */
let db = null;

/**
 * Open (or create) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      // Messages store
      if (!database.objectStoreNames.contains("messages")) {
        const msgStore = database.createObjectStore("messages", {
          keyPath: "id",
        });
        msgStore.createIndex("by-group-time", ["groupId", "timestamp"]);
        msgStore.createIndex("by-group", "groupId");
      }

      // Sessions store (conversation state per group)
      if (!database.objectStoreNames.contains("sessions")) {
        database.createObjectStore("sessions", { keyPath: "groupId" });
      }

      // Tasks store (scheduled tasks)
      if (!database.objectStoreNames.contains("tasks")) {
        const taskStore = database.createObjectStore("tasks", {
          keyPath: "id",
        });
        taskStore.createIndex("by-group", "groupId");
        taskStore.createIndex("by-enabled", "enabled");
      }

      // Config store (key-value)
      if (!database.objectStoreNames.contains("config")) {
        database.createObjectStore("config", { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onerror = () => {
      reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
    };
  });
}

/**
 * Get the database instance
 * @returns {IDBDatabase}
 */
function getDb() {
  if (!db)
    throw new Error("Database not initialized. Call openDatabase() first.");
  return db;
}

/**
 * Execute a transaction and return result
 * @template T
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} fn
 * @returns {Promise<T>}
 */
function txPromise(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Execute multiple requests in a transaction
 * @template T
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>[]} fn
 * @returns {Promise<T[]>}
 */
function txPromiseAll(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const requests = fn(store);
    const results = new Array(requests.length);
    let completed = 0;
    for (let i = 0; i < requests.length; i++) {
      requests[i].onsuccess = () => {
        results[i] = requests[i].result;
        if (++completed === requests.length) resolve(results);
      };
      requests[i].onerror = () => reject(requests[i].error);
    }
    if (requests.length === 0) resolve([]);
  });
}

// =========================================================================
// Messages
// =========================================================================

/**
 * Save a message to the database
 * @param {import('./types.mjs').StoredMessage} msg
 * @returns {Promise<void>}
 */
export function saveMessage(msg) {
  return txPromise("messages", "readwrite", (store) => store.put(msg)).then(
    () => undefined,
  );
}

/**
 * Get recent messages for a group
 * @param {string} groupId
 * @param {number} limit
 * @returns {Promise<import('./types.mjs').StoredMessage[]>}
 */
export function getRecentMessages(groupId, limit) {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index("by-group-time");
    const range = IDBKeyRange.bound([groupId, 0], [groupId, Infinity]);
    const request = index.openCursor(range, "prev");
    /** @type {any[]} */
    const results = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        // Reverse so oldest first
        resolve(results.reverse());
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get message count for a group
 * @param {string} groupId
 * @returns {Promise<number>}
 */
export function getMessageCount(groupId) {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index("by-group");
    const request = index.count(groupId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all group IDs from messages
 * @returns {Promise<string[]>}
 */
export function getAllGroupIds() {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index("by-group");
    const request = index.openKeyCursor(null, "nextunique");
    /** @type {any[]} */
    const ids = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        ids.push(cursor.key);
        cursor.continue();
      } else {
        resolve(ids);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

// =========================================================================
// Sessions
// =========================================================================

/**
 * Get session for a group
 * @param {string} groupId
 * @returns {Promise<import('./types.mjs').Session|undefined>}
 */
export function getSession(groupId) {
  return txPromise("sessions", "readonly", (store) => store.get(groupId));
}

/**
 * Save a session
 * @param {import('./types.mjs').Session} session
 * @returns {Promise<void>}
 */
export function saveSession(session) {
  return txPromise("sessions", "readwrite", (store) => store.put(session)).then(
    () => undefined,
  );
}

// =========================================================================
// Tasks
// =========================================================================

/**
 * Save a task to the database
 * @param {import('./types.mjs').Task} task
 * @returns {Promise<void>}
 */
export function saveTask(task) {
  // Store `enabled` as 0/1 so the IndexedDB 'by-enabled' index works
  const record = { ...task, enabled: task.enabled ? 1 : 0 };
  return txPromise("tasks", "readwrite", (store) => store.put(record)).then(
    () => undefined,
  );
}

/**
 * Delete a task
 * @param {string} id
 * @returns {Promise<void>}
 */
export function deleteTask(id) {
  return txPromise("tasks", "readwrite", (store) => store.delete(id)).then(
    () => undefined,
  );
}

/**
 * Get a task by ID
 * @param {string} id
 * @returns {Promise<import('./types.mjs').Task|undefined>}
 */
export function getTask(id) {
  return txPromise("tasks", "readonly", (store) => store.get(id)).then((t) =>
    t ? { ...t, enabled: !!t.enabled } : undefined,
  );
}

/**
 * Get all enabled tasks
 * @returns {Promise<import('./types.mjs').Task[]>}
 */
export function getEnabledTasks() {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction("tasks", "readonly");
    const store = tx.objectStore("tasks");
    const index = store.index("by-enabled");
    const request = index.getAll(1); // enabled = true (stored as 1)
    request.onsuccess = () => {
      // Convert numeric `enabled` back to boolean
      const tasks = request.result.map((t) => ({ ...t, enabled: true }));
      resolve(tasks);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all tasks
 * @returns {Promise<import('./types.mjs').Task[]>}
 */
export function getAllTasks() {
  return txPromise("tasks", "readonly", (store) => store.getAll()).then(
    (tasks) => tasks.map((t) => ({ ...t, enabled: !!t.enabled })),
  );
}

/**
 * Update task last run timestamp
 * @param {string} id
 * @param {number} timestamp
 * @returns {Promise<void>}
 */
export function updateTaskLastRun(id, timestamp) {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction("tasks", "readwrite");
    const store = tx.objectStore("tasks");
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const task = getReq.result;
      if (!task) {
        resolve();
        return;
      }
      task.lastRun = timestamp;
      const putReq = store.put(task);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// =========================================================================
// Config
// =========================================================================

/**
 * Get a config value
 * @param {string} key
 * @returns {Promise<string|undefined>}
 */
export function getConfig(key) {
  return txPromise("config", "readonly", (store) => store.get(key)).then(
    (entry) => entry?.value,
  );
}

/**
 * Set a config value
 * @param {string} key
 * @param {string} value
 * @returns {Promise<void>}
 */
export function setConfig(key, value) {
  return txPromise("config", "readwrite", (store) =>
    store.put({ key, value }),
  ).then(() => undefined);
}

/**
 * Delete a config value
 * @param {string} key
 * @returns {Promise<void>}
 */
export function deleteConfig(key) {
  return txPromise("config", "readwrite", (store) => store.delete(key)).then(
    () => undefined,
  );
}

/**
 * Get all config entries
 * @returns {Promise<import('./types.mjs').ConfigEntry[]>}
 */
export function getAllConfig() {
  return txPromise("config", "readonly", (store) => store.getAll());
}

/**
 * Delete all messages for a given group
 * @param {string} groupId
 * @returns {Promise<void>}
 */
export function clearGroupMessages(groupId) {
  return new Promise((resolve, reject) => {
    const tx = getDb().transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const index = store.index("by-group");
    const request = index.openCursor(groupId);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve(undefined);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

// =========================================================================
// Build conversation messages for Claude API from stored messages
// =========================================================================

/**
 * Build conversation messages for Claude API
 * @param {string} groupId
 * @param {number} limit
 * @returns {Promise<import('./types.mjs').ConversationMessage[]>}
 */
export async function buildConversationMessages(groupId, limit) {
  const messages = await getRecentMessages(groupId, limit);
  return messages.map((m) => ({
    role: m.isFromMe ? "assistant" : "user",
    content: m.isFromMe ? m.content : `${m.sender}: ${m.content}`,
  }));
}

// =========================================================================
// Export/Import chat data
// =========================================================================

/**
 * Export all chat data for a group (messages and session)
 * @param {string} groupId
 * @returns {Promise<{messages: any[], session: any}|null>}
 */
export async function exportChatData(groupId) {
  try {
    // Get all messages for this group
    const tx = getDb().transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index("by-group");
    const messages = await new Promise((resolve, reject) => {
      const request = index.getAll(groupId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    // Get session for this group
    const session = await getSession(groupId);

    return { messages, session };
  } catch (err) {
    console.error("Failed to export chat data:", err);
    return null;
  }
}

/**
 * Import chat data for a group (replaces existing data)
 * @param {string} groupId
 * @param {{messages: any[], session: any}} data
 * @returns {Promise<void>}
 */
export async function importChatData(groupId, data) {
  try {
    // Delete existing messages for this group
    await clearGroupMessages(groupId);

    // Delete existing session for this group
    const tx1 = getDb().transaction("sessions", "readwrite");
    const sessionStore = tx1.objectStore("sessions");
    await new Promise((resolve, reject) => {
      const request = sessionStore.delete(groupId);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });

    // Import messages
    if (data.messages && Array.isArray(data.messages)) {
      for (const msg of data.messages) {
        // Ensure the message has the correct groupId
        msg.groupId = groupId;
        await saveMessage(msg);
      }
    }

    // Import session
    if (data.session) {
      data.session.groupId = groupId;
      await saveSession(data.session);
    }
  } catch (err) {
    console.error("Failed to import chat data:", err);
    throw err;
  }
}
