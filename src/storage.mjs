/**
 * ShadowClaw — OPFS (Origin Private File System) helpers
 */

import { OPFS_ROOT, CONFIG_KEYS } from "./config.mjs";
import { getConfig, setConfig, deleteConfig } from "./db.mjs";
// @ts-ignore
import * as zip from "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.8.21/+esm";
import { formatDateForFilename } from "./utils.mjs";

/**
 * Get a handle to a nested directory, creating intermediate dirs.
 * @param {FileSystemDirectoryHandle} root
 * @param {...string} segments
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function getNestedDir(root, ...segments) {
  let current = root;
  for (const seg of segments) {
    current = await current.getDirectoryHandle(seg, { create: true });
  }
  return current;
}

/** @type {FileSystemDirectoryHandle | null} */
let explicitRoot = null;

/**
 * Get the current storage root handle.
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getStorageRoot() {
  if (explicitRoot) return explicitRoot;

  try {
    const handle = await getConfig(CONFIG_KEYS.STORAGE_HANDLE);
    if (
      handle &&
      /** @type {any} */ (handle) instanceof FileSystemDirectoryHandle
    ) {
      // Check if we still have permission
      const status = await /** @type {any} */ (handle).queryPermission({
        mode: "readwrite",
      });
      if (status === "granted") return handle;
      // Note: We don't fall back to OPFS here if a handle EXISTS but needs permission,
      // because that would lead to "split brain" where the user thinks they are in
      // their shared folder but are actually in OPFS.
      // However, for API calls, we might need a handle.
      // Tools will fail if they try to use it and it's not granted.
      return handle;
    }
  } catch (err) {
    console.warn("Failed to retrieve local storage handle:", err);
  }

  // Fallback to OPFS root
  const opfsRoot = await navigator.storage.getDirectory();
  return opfsRoot.getDirectoryHandle(OPFS_ROOT, { create: true });
}

/**
 * @typedef {Object} StorageStatus
 * @property {'opfs' | 'local'} type
 * @property {'granted' | 'denied' | 'prompt'} permission
 * @property {string | null} name
 */

/**
 * Get the current storage status.
 * @returns {Promise<StorageStatus>}
 */
export async function getStorageStatus() {
  if (explicitRoot) {
    return { type: "local", permission: "granted", name: explicitRoot.name };
  }

  try {
    const handle = await getConfig(CONFIG_KEYS.STORAGE_HANDLE);
    if (
      handle &&
      /** @type {any} */ (handle) instanceof FileSystemDirectoryHandle
    ) {
      const permission = await /** @type {any} */ (handle).queryPermission({
        mode: "readwrite",
      });
      return { type: "local", permission, name: handle.name };
    }
  } catch (err) {
    console.warn("Failed to check storage status:", err);
  }

  return { type: "opfs", permission: "granted", name: "OPFS" };
}

/**
 * Get the group workspace directory.
 * @param {string} groupId
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function getGroupDir(groupId) {
  const root = await getStorageRoot();
  // Sanitize groupId for filesystem: replace colons with dashes
  const safeId = groupId.replace(/:/g, "-");
  return getNestedDir(root, "groups", safeId);
}

/**
 * Get the workspace subdirectory for a group.
 * @param {string} groupId
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function getWorkspaceDir(groupId) {
  const groupDir = await getGroupDir(groupId);
  return groupDir.getDirectoryHandle("workspace", { create: true });
}

/**
 * Parse a path into directory segments and filename.
 * @param {string} filePath
 * @returns {{ dirs: string[]; filename: string }}
 */
function parsePath(filePath) {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("Empty file path");
  const filename = parts.pop();
  return { dirs: parts, filename: filename || "" };
}

// =========================================================================
// Public API
// =========================================================================

/**
 * Read a file from a group's workspace.
 * @param {string} groupId
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function readGroupFile(groupId, filePath) {
  const groupDir = await getGroupDir(groupId);
  const { dirs, filename } = parsePath(filePath);

  let dir = groupDir;
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg);
  }

  const fileHandle = await dir.getFileHandle(filename);
  const file = await fileHandle.getFile();
  return file.text();
}

/**
 * Write content to a file in a group's workspace.
 * Creates intermediate directories as needed.
 * @param {string} groupId
 * @param {string} filePath
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function writeGroupFile(groupId, filePath, content) {
  const groupDir = await getGroupDir(groupId);
  const { dirs, filename } = parsePath(filePath);

  let dir = groupDir;
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }

  const fileHandle = await dir.getFileHandle(filename, { create: true });
  // @ts-ignore - createWritable is a newer File System Access API method
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * List files and directories in a group's workspace directory.
 * @param {string} groupId
 * @param {string} [dirPath='.']
 * @returns {Promise<string[]>}
 */
export async function listGroupFiles(groupId, dirPath = ".") {
  const groupDir = await getGroupDir(groupId);

  let dir = groupDir;
  if (dirPath && dirPath !== ".") {
    const parts = dirPath
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean);
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg);
    }
  }

  const entries = [];
  // @ts-ignore - entries() is a newer File System Access API iterator method
  for await (const [name, handle] of dir.entries()) {
    entries.push(handle.kind === "directory" ? `${name}/` : name);
  }
  return entries.sort();
}

/**
 * Delete a file from a group's workspace.
 * @param {string} groupId
 * @param {string} filePath
 * @returns {Promise<void>}
 */
export async function deleteGroupFile(groupId, filePath) {
  const groupDir = await getGroupDir(groupId);
  const { dirs, filename } = parsePath(filePath);

  let dir = groupDir;
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg);
  }

  await dir.removeEntry(filename);
}

/**
 * Delete a directory recursively from a group's workspace.
 * @param {string} groupId
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
export async function deleteGroupDirectory(groupId, dirPath) {
  const groupDir = await getGroupDir(groupId);
  const { dirs, filename: dirName } = parsePath(dirPath.replace(/\/$/, ""));

  let dir = groupDir;
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg);
  }

  // recursive: true makes it delete non-empty directories
  await dir.removeEntry(dirName, { recursive: true });
}

/**
 * Check if a file exists in a group's workspace.
 * @param {string} groupId
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function groupFileExists(groupId, filePath) {
  try {
    await readGroupFile(groupId, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Request persistent storage so the browser doesn't evict our data.
 * @returns {Promise<boolean>}
 */
export async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    return navigator.storage.persist();
  }
  return false;
}

/**
 * Get storage usage estimate.
 * @returns {Promise<{usage: number; quota: number}>}
 */
export async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
    };
  }
  return { usage: 0, quota: 0 };
}

/**
 * Select a local directory for storage using the File System Access API.
 * @returns {Promise<boolean>} Success
 */
export async function selectStorageDirectory() {
  // @ts-ignore
  if (!window.showDirectoryPicker) {
    throw new Error("Local folder access not supported by this browser.");
  }

  try {
    // @ts-ignore
    const handle = await window.showDirectoryPicker({
      mode: "readwrite",
      id: "shadowclaw-storage",
    });

    // Verify it's not the same as OPFS or something restricted
    // (Most browsers handle this, but good to have a handle)
    await setConfig(CONFIG_KEYS.STORAGE_HANDLE, /** @type {any} */ (handle));
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return false;
    throw err;
  }
}

/**
 * Reset storage to use browser-internal OPFS.
 * @returns {Promise<void>}
 */
export async function resetStorageDirectory() {
  await deleteConfig(CONFIG_KEYS.STORAGE_HANDLE);
  explicitRoot = null;
}

/**
 * Set an explicit storage root handle (used to sync handle to workers).
 * @param {FileSystemDirectoryHandle} handle
 */
export function setStorageRoot(handle) {
  explicitRoot = handle;
}

/**
 * Check if the current storage is persistent.
 * @returns {Promise<boolean>}
 */
export async function isPersistent() {
  if (navigator.storage && navigator.storage.persisted) {
    return navigator.storage.persisted();
  }
  return false;
}

/**
 * Request storage handle permission if needed.
 * @returns {Promise<boolean>}
 */
export async function requestStorageAccess() {
  const handle = await getConfig(CONFIG_KEYS.STORAGE_HANDLE);
  if (
    handle &&
    /** @type {any} */ (handle) instanceof FileSystemDirectoryHandle
  ) {
    const status = await /** @type {any} */ (handle).requestPermission({
      mode: "readwrite",
    });
    return status === "granted";
  }
  return true; // No handle means OPFS, which always has "access"
}

/**
 * Recursively add a directory to zip writer
 * @private
 * @param {any} zipWriter
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} zipPath
 * @returns {Promise<void>}
 */
async function addDirToZip(zipWriter, dirHandle, zipPath = "") {
  // @ts-ignore - entries() is a newer File System Access API iterator method
  for await (const [name, handle] of dirHandle.entries()) {
    const fullPath = zipPath ? `${zipPath}/${name}` : name;
    if (handle.kind === "directory") {
      // Recursively add subdirectory
      await addDirToZip(zipWriter, handle, fullPath);
    } else {
      // Add file to zip
      const file = await handle.getFile();
      await zipWriter.add(fullPath, new zip.BlobReader(file));
    }
  }
}

/**
 * Download a single file
 * @param {string} groupId
 * @param {string} filePath
 * @returns {Promise<void>}
 */
export async function downloadGroupFile(groupId, filePath) {
  const groupDir = await getGroupDir(groupId);
  const { dirs, filename } = parsePath(filePath);

  let dir = groupDir;
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg);
  }

  const fileHandle = await dir.getFileHandle(filename);
  const file = await fileHandle.getFile();

  // Create a download link and trigger download
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Create a zip file of a directory and trigger download
 * @param {string} groupId
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
export async function downloadGroupDirectoryAsZip(groupId, dirPath) {
  const groupDir = await getGroupDir(groupId);
  const dirName = dirPath.replace(/\/$/, "").split("/").pop() || "archive";

  let dir = groupDir;
  if (dirPath && dirPath !== ".") {
    const parts = dirPath
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/$/, "")
      .split("/")
      .filter(Boolean);
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg);
    }
  }

  // Create a blob writer and zip writer
  const blobWriter = new zip.BlobWriter("application/zip");
  const zipWriter = new zip.ZipWriter(blobWriter);

  // Add all files and subdirectories to the zip
  await addDirToZip(zipWriter, dir);

  // Close the zip writer to finalize
  await zipWriter.close();

  // Get the blob
  const blob = await blobWriter.getData();

  // Create a download link and trigger download
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${dirName}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Upload a file to a group's workspace.
 * @param {string} groupId
 * @param {string} filePath
 * @param {Blob} blob
 * @returns {Promise<void>}
 */
export async function uploadGroupFile(groupId, filePath, blob) {
  const groupDir = await getGroupDir(groupId);
  const { dirs, filename } = parsePath(filePath);

  let dir = groupDir;
  for (const seg of dirs) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }

  const fileHandle = await dir.getFileHandle(filename, { create: true });
  // @ts-ignore - createWritable is a newer File System Access API method
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Recursively delete all files and directories in a group's workspace.
 * @param {string} groupId
 * @returns {Promise<void>}
 */
export async function deleteAllGroupFiles(groupId) {
  const groupDir = await getGroupDir(groupId);

  // Delete everything in the group directory
  // @ts-ignore - entries() is a newer File System Access API iterator method
  for await (const [name] of groupDir.entries()) {
    await groupDir.removeEntry(name, { recursive: true });
  }
}

/**
 * Download entire group workspace as a zip file
 * @param {string} groupId
 * @returns {Promise<void>}
 */
export async function downloadAllGroupFilesAsZip(groupId) {
  const groupDir = await getGroupDir(groupId);

  // Create a blob writer and zip writer
  const blobWriter = new zip.BlobWriter("application/zip");
  const zipWriter = new zip.ZipWriter(blobWriter);

  // Add all files and subdirectories to the zip
  await addDirToZip(zipWriter, groupDir);

  // Close the zip writer to finalize
  await zipWriter.close();

  // Get the blob
  const blob = await blobWriter.getData();

  // Create a download link and trigger download
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `shadowclaw-backup-${formatDateForFilename()}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Restore files from a zip backup into group workspace,
 * replacing all existing files.
 * @param {string} groupId
 * @param {Blob} zipBlob
 * @returns {Promise<void>}
 */
export async function restoreAllGroupFilesFromZip(groupId, zipBlob) {
  // First, delete all existing files
  await deleteAllGroupFiles(groupId);

  // Get the group directory
  const groupDir = await getGroupDir(groupId);

  // Create a blob reader from the zip blob
  const blobReader = new zip.BlobReader(zipBlob);
  const zipReader = new zip.ZipReader(blobReader);

  // Get all entries from the zip
  const entries = await zipReader.getEntries();

  // Extract each entry
  for (const entry of entries) {
    if (!entry.directory) {
      // Get the file blob from the zip entry
      const blob = await entry.getData(new zip.BlobWriter());

      // Create nested directories if needed
      const parts = entry.filename.split("/").filter(Boolean);
      const filename = parts.pop();
      if (!filename) continue; // Skip if no filename (directory entry)

      let currentDir = groupDir;
      for (const dirName of parts) {
        currentDir = await currentDir.getDirectoryHandle(dirName, {
          create: true,
        });
      }

      // Write the file
      const fileHandle = await currentDir.getFileHandle(filename, {
        create: true,
      });
      // @ts-ignore - createWritable is a newer File System Access API method
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    }
  }

  // Close the zip reader
  await zipReader.close();
}
