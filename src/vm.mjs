/**
 * ShadowClaw — WebVM wrapper (v86-based Alpine Linux in WebAssembly)
 *
 * This module manages a lightweight Linux VM running inside a Web Worker.
 * The VM is booted eagerly when the worker starts and cached for reuse.
 * Commands fall back to the JS shell emulator while the VM is still booting.
 *
 * Implementation notes:
 * - Can use v86 (https://github.com/copy/v86.git) or compatible WASM emulator
 */

/**
 * @typedef {Object} VMResult
 *
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} exitCode
 * @property {boolean} timedOut
 */

/**
 * @typedef {Object} VMInstance
 *
 * @property {() => boolean} isReady
 * @property {(command: string, timeoutSec: number) => Promise<VMResult>} execute
 * @property {() => void} destroy
 */

/** @type {VMInstance|null} */
let instance = null;
let booting = false;
let bootAttempted = false;

/** @type {string|null} */
let lastBootError = null;

/** @type {any} */
let activeEmulator = null; // Track emulator for cleanup on failure

/**
 * Boot the VM. Idempotent — only boots once.
 * Called eagerly from the worker so the VM is ready by the time the user needs it.
 * @returns {Promise<void>}
 */
export async function bootVM() {
  if (instance?.isReady()) return;
  if (bootAttempted) return; // Only attempt boot once per page load

  bootAttempted = true;
  booting = true;

  try {
    await doBootVM();
  } finally {
    booting = false;
  }
}

/**
 * Execute a command in the VM.
 *
 * Does NOT block on boot — if the VM isn't ready, returns an error immediately
 * so the caller can fall back to the JS shell emulator.
 *
 * @param {string} command
 * @param {number} [timeoutSec=30]
 *
 * @returns {Promise<string>}
 */
export async function executeInVM(command, timeoutSec = 30) {
  if (!instance?.isReady()) {
    const detail = lastBootError
      ? `\nReason: ${lastBootError}`
      : booting
        ? "\nReason: VM is still booting in the background..."
        : "";

    return (
      "Error: WebVM is not available. The VM requires local assets " +
      "served at /assets/ (alpine-fs.json, libv86.mjs, etc). " +
      'Use the "javascript" tool for code execution, or the "fetch_url" tool for HTTP requests.' +
      detail
    );
  }

  const result = await instance.execute(command, timeoutSec);

  let output = "";
  if (result.stdout) output += result.stdout;
  if (result.stderr) output += (output ? "\n" : "") + result.stderr;
  if (result.timedOut) output += "\n[command timed out]";
  if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`;

  return output || "(no output)";
}

/**
 * Shut down the VM and free resources.
 *
 * @returns {Promise<void>}
 */
export async function shutdownVM() {
  instance?.destroy();
  instance = null;

  if (activeEmulator) {
    try {
      activeEmulator.destroy();
    } catch (_) {
      /* ignore */
    }

    activeEmulator = null;
  }
}

/**
 * Check if the VM is booted and ready for commands.
 *
 * @returns {boolean}
 */
export function isVMReady() {
  return instance?.isReady() ?? false;
}

/**
 * Boot the VM (internal implementation)
 *
 * @returns {Promise<void>}
 */
async function doBootVM() {
  /** @type {any} */
  let emulator = null;

  try {
    const ext2Url = "/assets/alpine-rootfs.ext2";
    const bzImageUrl = "/assets/bzImage";
    const initrdUrl = "/assets/initrd";
    const wasmUrl = "/assets/v86.wasm";

    console.log("[WebVM] Starting boot — checking assets...");

    // Check if assets exist
    const [ext2Check, bzImageCheck, initrdCheck, wasmCheck] = await Promise.all(
      [
        fetch(ext2Url, { method: "HEAD" }).catch(() => null),
        fetch(bzImageUrl, { method: "HEAD" }).catch(() => null),
        fetch(initrdUrl, { method: "HEAD" }).catch(() => null),
        fetch(wasmUrl, { method: "HEAD" }).catch(() => null),
      ],
    );

    if (
      !ext2Check?.ok ||
      !bzImageCheck?.ok ||
      !initrdCheck?.ok ||
      !wasmCheck?.ok
    ) {
      const msg = `Assets not found (ext2: ${ext2Check?.status ?? "failed"}, bzImage: ${bzImageCheck?.status ?? "failed"}, initrd: ${initrdCheck?.status ?? "failed"}, v86.wasm: ${wasmCheck?.status ?? "failed"})`;

      console.warn(
        `[WebVM] ${msg}. The bash tool will fall back to the JS shell emulator.`,
      );

      lastBootError = msg;

      return;
    }

    console.log("[WebVM] Assets found. Loading v86 module...");

    // Dynamically import v86
    let V86;
    try {
      // Use local v86 module from assets
      // @ts-ignore
      const v86Module = await import("/assets/libv86.mjs");
      V86 = v86Module.V86 || v86Module.default;

      if (!V86) {
        console.error(
          "[WebVM] libv86.mjs loaded but V86 constructor not found. Exports:",
          Object.keys(v86Module),
        );

        lastBootError = "V86 constructor not found in libv86.mjs";

        return;
      }
    } catch (err) {
      console.error("[WebVM] Failed to import libv86.mjs:", err);

      lastBootError = `Failed to import libv86.mjs: ${err instanceof Error ? err.message : String(err)}`;

      return;
    }

    console.log("[WebVM] v86 module loaded. Creating emulator...");

    // Boot emulator in headless mode
    emulator = new V86({
      wasm_path: wasmUrl,
      memory_size: 512 * 1024 * 1024, // 512 MB
      vga_memory_size: 0,
      bios: { url: "/assets/seabios.bin" },
      vga_bios: { url: "/assets/vgabios.bin" },
      bzimage: { url: bzImageUrl },
      initrd: { url: initrdUrl },
      hda: { url: ext2Url, async: true },
      // Important to use the ext2 label or /dev/sda root and rely on virtio if needed.
      // E.g., root=/dev/sda init=/sbin/init
      cmdline:
        "rw root=/dev/sda rootfstype=ext2 tsc=reliable console=ttyS0 fsck.mode=skip rootdelay=1",
      autostart: true,
      disable_keyboard: true,
      disable_mouse: true,
      disable_speaker: true,
      serial_container: null,
    });

    // Track the emulator for cleanup
    activeEmulator = emulator;

    console.log(
      "[WebVM] Emulator created. Waiting for login prompt (600s timeout)...",
    );

    // Log serial output during boot for debugging
    /** @type {string} */
    let bootLog = "";

    /** @param {number} byte */
    const bootLogger = (byte) => {
      const ch = String.fromCharCode(byte);

      bootLog += ch;

      if (ch === "\n") {
        const line = bootLog.trimEnd();

        if (line) console.log("[WebVM boot]", line);

        bootLog = "";
      }
    };

    if (emulator.add_listener) {
      emulator.add_listener("serial0-output-byte", bootLogger);
    }

    // Wait for shell prompt — 9p boot from chunks is slow, allow 600s
    await waitForSerial(emulator, "login:", 600_000);

    // Remove boot logger
    if (emulator.remove_listener) {
      emulator.remove_listener("serial0-output-byte", bootLogger);
    }

    console.log("[WebVM] Got login prompt...");

    emulator.serial0_send("root\n");

    await waitForSerial(emulator, "# ", 60000);

    instance = {
      isReady: () => true,
      destroy: () => {
        try {
          emulator?.destroy();
        } catch (_) {
          /* ignore */
        }
        instance = null;
        activeEmulator = null;
      },
      execute: (cmd, timeout) => executeCommand(emulator, cmd, timeout),
    };

    activeEmulator = emulator; // Keep reference for cleanup
    console.log(
      "[WebVM] ✅ WebVM booted successfully — bash tool is using full Alpine Linux VM",
    );
    lastBootError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    console.error("[WebVM] ❌ Failed to boot WebVM:", msg);

    lastBootError = msg;

    // CRITICAL: Destroy the emulator on failure to stop it from fetching more chunks
    if (emulator) {
      console.log("[WebVM] Destroying emulator to stop chunk downloads...");

      try {
        emulator.destroy();
      } catch (_) {
        /* ignore */
      }

      activeEmulator = null;
    }

    console.warn(
      "[WebVM] The bash tool will fall back to the JS shell emulator.",
    );
  }
}

/**
 * Wait for serial output to contain needle
 *
 * @param {any} emulator
 * @param {string} needle
 * @param {number} timeoutMs
 *
 * @returns {Promise<void>}
 */
function waitForSerial(emulator, needle, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const timer = setTimeout(() => {
      if (emulator.remove_listener) {
        emulator.remove_listener("serial0-output-byte", listener);
      }

      reject(new Error(`Timeout waiting for "${needle}"`));
    }, timeoutMs);

    /** @param {number} byte */
    const listener = (byte) => {
      buffer += String.fromCharCode(byte);

      if (buffer.includes(needle)) {
        clearTimeout(timer);

        if (emulator.remove_listener) {
          emulator.remove_listener("serial0-output-byte", listener);
        }

        resolve();
      }
    };

    if (emulator.add_listener) {
      emulator.add_listener("serial0-output-byte", listener);
    }
  });
}

/**
 * Execute a command in the emulator
 *
 * @param {any} emulator
 * @param {string} command
 * @param {number} timeoutSec
 *
 * @returns {Promise<VMResult>}
 */
function executeCommand(emulator, command, timeoutSec) {
  return new Promise((resolve) => {
    const marker = `__BCDONE_${Date.now()}__`;

    let output = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;

      if (emulator.remove_listener) {
        emulator.remove_listener("serial0-output-byte", listener);
      }

      resolve({ stdout: output, stderr: "", exitCode: 1, timedOut: true });
    }, timeoutSec * 1000);

    /** @param {number} byte */
    const listener = (byte) => {
      const ch = String.fromCharCode(byte);
      output += ch;

      if (output.includes(marker)) {
        clearTimeout(timer);

        if (emulator.remove_listener) {
          emulator.remove_listener("serial0-output-byte", listener);
        }

        const parts = output.split(marker);
        const exitCode = parseInt(parts[1] || "0", 10);

        resolve({
          stdout: parts[0],
          stderr: "",
          exitCode,
          timedOut: false,
        });
      }
    };

    // Send command
    if (emulator.add_listener) {
      emulator.add_listener("serial0-output-byte", listener);
    }

    emulator.serial0_send(`${command} 2>&1; echo "${marker}$?"\n`);
  });
}
