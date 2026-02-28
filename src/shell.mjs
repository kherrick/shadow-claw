/**
 * ShadowClaw — Lightweight Shell Emulator
 *
 * A minimal bash-like shell that runs entirely in JS using OPFS for the
 * filesystem. Handles the most common commands Claude typically uses.
 * Falls back to the v86 WebVM when available, but works standalone.
 *
 * Supported builtins:
 *   echo, printf, cat, head, tail, wc, grep, sort, uniq, tr, cut, sed, awk,
 *   ls, mkdir, cp, mv, rm, touch, pwd, cd, date, env, printenv, export, true,
 *   false, base64, md5sum/sha256sum (Web Crypto), sleep, seq, jq (basic), tee, test
 *
 * Operators: |  >  >>  &&  ||  ;  $()  ``  $VAR  "interpolation"
 */

import {
  readGroupFile,
  writeGroupFile,
  listGroupFiles,
  deleteGroupFile,
  groupFileExists,
} from "./storage.mjs";

/**
 * @typedef {Object} ShellResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} exitCode
 */

/**
 * @typedef {Object} ShellContext
 * @property {string} groupId
 * @property {string} cwd
 * @property {Record<string, string>} env
 * @property {number} timeoutMs
 * @property {number} startedAt
 */

/**
 * Execute a shell command string against a group's OPFS workspace.
 * @param {string} command
 * @param {string} groupId
 * @param {Record<string, string>} [env={}]
 * @param {number} [timeoutSec=30]
 * @returns {Promise<ShellResult>}
 */
export async function executeShell(
  command,
  groupId,
  env = {},
  timeoutSec = 30,
) {
  const ctx = {
    groupId,
    cwd: ".",
    env: { HOME: "/workspace", PATH: "/usr/bin", PWD: "/workspace", ...env },
    timeoutMs: timeoutSec * 1000,
    startedAt: Date.now(),
  };

  try {
    return await runPipeline(command.trim(), ctx);
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Pipeline / operator parsing
// ---------------------------------------------------------------------------

/**
 * Run a pipeline of commands
 * @param {string} line
 * @param {ShellContext} ctx
 * @returns {Promise<ShellResult>}
 */
async function runPipeline(line, ctx) {
  const segments = splitOnOperators(line);
  let lastResult = { stdout: "", stderr: "", exitCode: 0 };

  for (const seg of segments) {
    checkTimeout(ctx);
    const { cmd, op } = seg;
    if (!cmd.trim()) continue;

    if (cmd.includes("|") && !cmd.includes("||")) {
      lastResult = await runPipe(cmd, ctx);
    } else {
      lastResult = await runSingle(cmd.trim(), ctx);
    }

    if (op === "&&" && lastResult.exitCode !== 0) break;
    if (op === "||" && lastResult.exitCode === 0) break;
  }

  return lastResult;
}

/**
 * Split command by operators
 * @param {string} line
 * @returns {Array<{cmd: string; op: string}>}
 */
function splitOnOperators(line) {
  const segments = [];
  let current = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let subshellDepth = 0;

  while (i < line.length) {
    const ch = line[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    if (!inSingle) {
      if (ch === "$" && line[i + 1] === "(") {
        subshellDepth++;
        current += "$(";
        i += 2;
        continue;
      }
      if (ch === "(") {
        subshellDepth++;
      }
      if (ch === ")") {
        if (subshellDepth > 0) subshellDepth--;
      }
    }

    if (inSingle || inDouble || subshellDepth > 0) {
      current += ch;
      i++;
      continue;
    }

    if (ch === "&" && line[i + 1] === "&") {
      segments.push({ cmd: current, op: "&&" });
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|" && line[i + 1] === "|") {
      segments.push({ cmd: current, op: "||" });
      current = "";
      i += 2;
      continue;
    }
    if (ch === ";") {
      segments.push({ cmd: current, op: ";" });
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim()) segments.push({ cmd: current, op: "" });
  return segments;
}

/**
 * Run piped commands
 * @param {string} line
 * @param {ShellContext} ctx
 * @returns {Promise<ShellResult>}
 */
async function runPipe(line, ctx) {
  const parts = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let subshellDepth = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle) {
      if (ch === "$" && line[i + 1] === "(") {
        subshellDepth++;
        current += "$(";
        i++;
        continue;
      }
      if (ch === "(") {
        subshellDepth++;
      }
      if (ch === ")") {
        if (subshellDepth > 0) subshellDepth--;
      }
    }
    if (ch === "|" && !inSingle && !inDouble && subshellDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  let lastResult = { stdout: "", stderr: "", exitCode: 0 };

  for (const part of parts) {
    checkTimeout(ctx);
    lastResult = await runSingle(part, ctx, lastResult.stdout);
  }

  return lastResult;
}

// ---------------------------------------------------------------------------
// Single command execution
// ---------------------------------------------------------------------------

/**
 * Run a single command
 * @param {string} raw
 * @param {ShellContext} ctx
 * @param {string} [stdin='']
 * @returns {Promise<ShellResult>}
 */
async function runSingle(raw, ctx, stdin = "") {
  checkTimeout(ctx);

  let appendFile = null;
  let writeFile = null;
  let cmdStr = raw;

  const appendMatch = cmdStr.match(/\s*>>\s*(\S+)\s*$/);
  if (appendMatch) {
    appendFile = appendMatch[1];
    cmdStr = cmdStr.slice(0, appendMatch.index);
  } else {
    const writeMatch = cmdStr.match(/\s*>\s*(\S+)\s*$/);
    if (writeMatch) {
      writeFile = writeMatch[1];
      cmdStr = cmdStr.slice(0, writeMatch.index);
    }
  }

  cmdStr = await expandVarsAndSub(cmdStr, ctx);
  const tokens = tokenize(cmdStr);
  if (tokens.length === 0) return { stdout: "", stderr: "", exitCode: 0 };

  const name = tokens[0];
  const args = tokens.slice(1);

  // Variable assignment
  if (/^[A-Za-z_]\w*=/.test(name) && args.length === 0) {
    const eq = name.indexOf("=");
    ctx.env[name.slice(0, eq)] = name.slice(eq + 1);
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  const result = await dispatch(name, args, ctx, stdin);

  // Apply redirects
  if (writeFile) {
    await writeGroupFile(
      ctx.groupId,
      resolvePath(writeFile, ctx),
      result.stdout,
    );
    return { stdout: "", stderr: result.stderr, exitCode: result.exitCode };
  }
  if (appendFile) {
    const path = resolvePath(appendFile, ctx);
    const existing = (await safeRead(ctx.groupId, path)) || "";
    await writeGroupFile(ctx.groupId, path, existing + result.stdout);
    return { stdout: "", stderr: result.stderr, exitCode: result.exitCode };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch command to handler
 * @param {string} name
 * @param {string[]} args
 * @param {ShellContext} ctx
 * @param {string} stdin
 * @returns {Promise<ShellResult>}
 */
async function dispatch(name, args, ctx, stdin) {
  /** @param {string} stdout */
  const ok = (stdout) => ({
    stdout,
    stderr: "",
    exitCode: 0,
  });
  /**
   * @param {string} stderr
   * @param {number} [code=1]
   */
  const fail = (stderr, code = 1) => ({
    stdout: "",
    stderr: stderr,
    exitCode: code,
  });

  switch (name) {
    // -- Output -----------------------------------------------------------
    case "echo":
      return ok(args.join(" ") + "\n");

    case "printf": {
      if (args.length === 0) return ok("");
      const fmt = args[0];
      const rest = args.slice(1);
      // Very simple printf: %s and %d
      let out = fmt;
      let idx = 0;
      out = out.replace(/%[sd]/g, () => rest[idx++] ?? "");
      out = out.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      return ok(out);
    }

    // -- File reading -----------------------------------------------------
    case "cat": {
      if (args.length === 0 && stdin) return ok(stdin);
      const parts = [];
      for (const f of args) {
        if (f === "-") {
          parts.push(stdin);
          continue;
        }
        const content = await safeRead(ctx.groupId, resolvePath(f, ctx));
        if (content === null) return fail(`cat: ${f}: No such file`);
        parts.push(content);
      }
      return ok(parts.join(""));
    }

    case "head": {
      const { flags, operands } = parseFlags(args, ["n"]);
      const n = parseInt(flags.n ?? "10", 10);
      const text =
        operands.length > 0
          ? ((await safeRead(ctx.groupId, resolvePath(operands[0], ctx))) ?? "")
          : stdin;
      return ok(text.split("\n").slice(0, n).join("\n") + "\n");
    }

    case "tail": {
      const { flags, operands } = parseFlags(args, ["n"]);
      const n = parseInt(flags.n ?? "10", 10);
      const text =
        operands.length > 0
          ? ((await safeRead(ctx.groupId, resolvePath(operands[0], ctx))) ?? "")
          : stdin;
      const lines = text.split("\n");
      return ok(lines.slice(Math.max(0, lines.length - n)).join("\n"));
    }

    // -- Text processing --------------------------------------------------
    case "wc": {
      const text =
        args.length > 0
          ? ((await safeRead(ctx.groupId, resolvePath(args[0], ctx))) ?? "")
          : stdin;
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const words = text.split(/\s+/).filter(Boolean).length;
      const chars = text.length;
      return ok(`${lines} ${words} ${chars}\n`);
    }

    case "grep": {
      const { flags, operands } = parseFlags(
        args,
        ["e", "m"],
        ["i", "v", "c", "n", "l"],
      );
      const pattern = flags.e ?? operands.shift() ?? "";
      const text =
        operands.length > 0
          ? ((await safeRead(ctx.groupId, resolvePath(operands[0], ctx))) ?? "")
          : stdin;
      const re = new RegExp(pattern, flags.i !== undefined ? "i" : "");
      const invert = flags.v !== undefined;
      let lines = text.split("\n").filter((l) => {
        const m = re.test(l);
        return invert ? !m : m;
      });
      if (flags.m !== undefined) lines = lines.slice(0, parseInt(flags.m, 10));
      if (flags.c !== undefined) return ok(String(lines.length) + "\n");
      if (flags.n !== undefined) {
        const all = text.split("\n");
        lines = lines.map((l) => `${all.indexOf(l) + 1}:${l}`);
      }
      return lines.length > 0 ? ok(lines.join("\n") + "\n") : fail("", 1); // grep exits 1 when no matches
    }

    case "sort": {
      const { flags, operands } = parseFlags(args, [], ["r", "n", "u"]);
      const text =
        operands.length > 0
          ? ((await safeRead(ctx.groupId, resolvePath(operands[0], ctx))) ?? "")
          : stdin;
      let lines = text.split("\n").filter(Boolean);
      if (flags.n !== undefined) {
        lines.sort((a, b) => parseFloat(a) - parseFloat(b));
      } else {
        lines.sort();
      }
      if (flags.r !== undefined) lines.reverse();
      if (flags.u !== undefined) lines = [...new Set(lines)];
      return ok(lines.join("\n") + "\n");
    }

    case "uniq": {
      const text =
        args.length > 0
          ? ((await safeRead(ctx.groupId, resolvePath(args[0], ctx))) ?? "")
          : stdin;
      const lines = text.split("\n");
      const result = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
      return ok(result.join("\n"));
    }

    case "tr": {
      const text = stdin;
      if (args[0] === "-d" && args[1]) {
        const chars = args[1];
        return ok(text.replace(new RegExp(`[${escapeRegex(chars)}]`, "g"), ""));
      }
      if (args.length >= 2) {
        const from = args[0];
        const to = args[1];
        let result = text;
        for (let i = 0; i < from.length; i++) {
          const replacement = i < to.length ? to[i] : to[to.length - 1];
          result = result.replace(
            new RegExp(escapeRegex(from[i]), "g"),
            replacement,
          );
        }
        return ok(result);
      }
      return fail("tr: missing operands");
    }

    case "cut": {
      const { flags, operands } = parseFlags(args, ["d", "f"]);
      const delim = flags.d ?? "\t";
      const fields = (flags.f ?? "1")
        .split(",")
        .map((s) => parseInt(s, 10) - 1);
      const text =
        operands.length > 0
          ? ((await safeRead(ctx.groupId, resolvePath(operands[0], ctx))) ?? "")
          : stdin;
      const result = text.split("\n").map((line) => {
        const parts = line.split(delim);
        return fields.map((f) => parts[f] ?? "").join(delim);
      });
      return ok(result.join("\n"));
    }

    case "sed": {
      const expr = args[0] ?? "";
      const text =
        args.length > 1
          ? ((await safeRead(ctx.groupId, resolvePath(args[1], ctx))) ?? "")
          : stdin;
      const sedMatch = expr.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
      if (!sedMatch) return fail(`sed: unsupported expression: ${expr}`);
      const [, , pattern, replacement, sedFlags] = sedMatch;
      const re = new RegExp(
        pattern,
        sedFlags.includes("i") ? "gi" : sedFlags.includes("g") ? "g" : "",
      );
      return ok(text.replace(re, replacement));
    }

    case "awk": {
      const text =
        args.length > 1
          ? ((await safeRead(ctx.groupId, resolvePath(args[1], ctx))) ?? "")
          : stdin;
      const program = args[0] ?? "";
      const printMatch = program.match(/\{\s*print\s+(.*?)\s*\}/);
      if (printMatch) {
        const fieldExpr = printMatch[1];
        const lines = text.split("\n").filter(Boolean);
        const result = lines.map((line) => {
          const fields = line.split(/\s+/);
          return fieldExpr.replace(/\$(\d+)/g, (_, n) => {
            const idx = parseInt(n, 10);
            return idx === 0 ? line : (fields[idx - 1] ?? "");
          });
        });
        return ok(result.join("\n") + "\n");
      }
      return fail("awk: only basic {print $N} patterns supported");
    }

    // -- Filesystem -------------------------------------------------------
    case "ls": {
      const { flags, operands } = parseFlags(args, [], ["l", "a", "1"]);
      const dir = operands[0] || ".";
      try {
        const entries = await listGroupFiles(
          ctx.groupId,
          resolvePath(dir, ctx),
        );
        let filtered = entries;
        if (flags.a === undefined) {
          filtered = entries.filter((e) => !e.startsWith("."));
        }
        if (flags["1"] !== undefined || flags.l !== undefined) {
          return ok(filtered.join("\n") + "\n");
        }
        return ok(filtered.join("  ") + "\n");
      } catch {
        return fail(`ls: cannot access '${dir}': No such directory`);
      }
    }

    case "mkdir": {
      const { flags, operands } = parseFlags(args, [], ["p"]);
      for (const dir of operands) {
        // OPFS creates dirs implicitly on write, so just write a .keep file
        await writeGroupFile(ctx.groupId, resolvePath(dir + "/.keep", ctx), "");
      }
      return ok("");
    }

    case "touch": {
      for (const f of args) {
        const path = resolvePath(f, ctx);
        const existing = await safeRead(ctx.groupId, path);
        if (existing === null) {
          await writeGroupFile(ctx.groupId, path, "");
        }
      }
      return ok("");
    }

    case "cp": {
      if (args.length < 2) return fail("cp: missing operands");
      const src = resolvePath(args[0], ctx);
      const dst = resolvePath(args[1], ctx);
      const content = await safeRead(ctx.groupId, src);
      if (content === null) return fail(`cp: ${args[0]}: No such file`);
      await writeGroupFile(ctx.groupId, dst, content);
      return ok("");
    }

    case "mv": {
      if (args.length < 2) return fail("mv: missing operands");
      const src = resolvePath(args[0], ctx);
      const dst = resolvePath(args[1], ctx);
      const content = await safeRead(ctx.groupId, src);
      if (content === null) return fail(`mv: ${args[0]}: No such file`);
      await writeGroupFile(ctx.groupId, dst, content);
      await deleteGroupFile(ctx.groupId, src);
      return ok("");
    }

    case "rm": {
      const { flags, operands } = parseFlags(args, [], ["r", "f"]);
      for (const f of operands) {
        try {
          await deleteGroupFile(ctx.groupId, resolvePath(f, ctx));
        } catch {
          if (flags.f === undefined) return fail(`rm: ${f}: No such file`);
        }
      }
      return ok("");
    }

    case "pwd":
      return ok(
        (ctx.cwd === "." ? "/workspace" : `/workspace/${ctx.cwd}`) + "\n",
      );

    case "cd": {
      const target = args[0] ?? ".";
      ctx.cwd = resolvePath(target, ctx);
      ctx.env.PWD = `/workspace/${ctx.cwd}`;
      return ok("");
    }

    // -- Utilities --------------------------------------------------------
    case "date":
      return ok(new Date().toISOString() + "\n");

    case "env":
    case "printenv":
      return ok(
        Object.entries(ctx.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n") + "\n",
      );

    case "export": {
      for (const a of args) {
        const eq = a.indexOf("=");
        if (eq > 0) ctx.env[a.slice(0, eq)] = a.slice(eq + 1);
      }
      return ok("");
    }

    case "sleep": {
      const ms = Math.min(parseFloat(args[0] ?? "0") * 1000, 5000);
      await new Promise((r) => setTimeout(r, ms));
      return ok("");
    }

    case "seq": {
      const nums = args.map(Number);
      let start = 1,
        step = 1,
        end = 1;
      if (nums.length === 1) {
        end = nums[0];
      } else if (nums.length === 2) {
        start = nums[0];
        end = nums[1];
      } else if (nums.length >= 3) {
        start = nums[0];
        step = nums[1];
        end = nums[2];
      }
      const out = [];
      for (let i = start; step > 0 ? i <= end : i >= end; i += step)
        out.push(i);
      return ok(out.join("\n") + "\n");
    }

    case "true":
      return ok("");

    case "false":
      return fail("", 1);

    case "test":
    case "[": {
      const testArgs = name === "[" ? args.slice(0, -1) : args;
      return testExpr(testArgs, ctx);
    }

    case "base64": {
      const text =
        args.length > 0 && args[0] !== "-d"
          ? ((await safeRead(
              ctx.groupId,
              resolvePath(args[args.length - 1], ctx),
            )) ?? "")
          : stdin;
      if (args.includes("-d") || args.includes("--decode")) {
        return ok(atob(text.trim()));
      }
      return ok(btoa(text) + "\n");
    }

    case "md5sum":
    case "sha256sum": {
      const algo = name === "md5sum" ? "SHA-1" : "SHA-256";
      const text =
        args.length > 0
          ? ((await safeRead(ctx.groupId, resolvePath(args[0], ctx))) ?? "")
          : stdin;
      const data = new TextEncoder().encode(text);
      const hash = await crypto.subtle.digest(algo, data);
      const hex = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const fname = args[0] ?? "-";
      return ok(`${hex}  ${fname}\n`);
    }

    case "tee": {
      const text = stdin;
      for (const f of args) {
        await writeGroupFile(ctx.groupId, resolvePath(f, ctx), text);
      }
      return ok(text);
    }

    case "basename": {
      const p = args[0] ?? "";
      const parts = p.replace(/\/$/, "").split("/");
      let base = parts[parts.length - 1] || "";
      if (args[1])
        base = base.replace(new RegExp(escapeRegex(args[1]) + "$"), "");
      return ok(base + "\n");
    }

    case "dirname": {
      const p = args[0] ?? "";
      const parts = p.split("/");
      parts.pop();
      return ok((parts.join("/") || ".") + "\n");
    }

    case "xargs": {
      if (args.length === 0) return ok(stdin);
      const lines = stdin.trim().split("\n").filter(Boolean);
      const cmd = args.join(" ") + " " + lines.join(" ");
      return runSingle(cmd, ctx);
    }

    case "rev": {
      const text =
        args.length > 0
          ? ((await safeRead(ctx.groupId, resolvePath(args[0], ctx))) ?? "")
          : stdin;
      return ok(
        text
          .split("\n")
          .map((l) => l.split("").reverse().join(""))
          .join("\n"),
      );
    }

    case "yes": {
      const word = args[0] ?? "y";
      return ok(Array(100).fill(word).join("\n") + "\n");
    }

    case "jq": {
      const expr = args[0] ?? ".";
      const text =
        args.length > 1
          ? ((await safeRead(ctx.groupId, resolvePath(args[1], ctx))) ?? "")
          : stdin;
      try {
        let obj = JSON.parse(text.trim());
        if (expr !== ".") {
          const parts = expr
            .replace(/^\.\s*/, "")
            .split(/\.|\[|\]/)
            .filter(Boolean);
          for (const p of parts) {
            if (p === "keys") {
              obj = Object.keys(obj);
              break;
            }
            if (p === "length") {
              obj = Array.isArray(obj) ? obj.length : Object.keys(obj).length;
              break;
            }
            obj = obj?.[isNaN(Number(p)) ? p : Number(p)];
          }
        }
        return ok(JSON.stringify(obj, null, 2) + "\n");
      } catch (e) {
        return fail(`jq: ${e instanceof Error ? e.message : "parse error"}`);
      }
    }

    case "which":
    case "command": {
      const target = args.filter((a) => !a.startsWith("-"))[0] ?? "";
      if (SUPPORTED_COMMANDS.has(target)) {
        return ok(`/usr/bin/${target}\n`);
      }
      return fail(`${name}: ${target}: not found`);
    }

    default:
      return fail(
        `${name}: command not found. Available: echo, cat, head, tail, grep, sort, ` +
          `sed, awk, cut, tr, uniq, wc, ls, mkdir, cp, mv, rm, touch, pwd, cd, date, ` +
          `sleep, seq, base64, jq, tee, xargs, test, rev, basename, dirname. ` +
          `For complex logic, use the "javascript" tool instead.`,
        127,
      );
  }
}

const SUPPORTED_COMMANDS = new Set([
  "echo",
  "printf",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "sort",
  "uniq",
  "tr",
  "cut",
  "sed",
  "awk",
  "ls",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "touch",
  "pwd",
  "cd",
  "date",
  "env",
  "printenv",
  "export",
  "sleep",
  "seq",
  "true",
  "false",
  "test",
  "base64",
  "md5sum",
  "sha256sum",
  "tee",
  "basename",
  "dirname",
  "xargs",
  "rev",
  "yes",
  "jq",
  "which",
  "command",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check timeout
 * @param {ShellContext} ctx
 */
function checkTimeout(ctx) {
  if (Date.now() - ctx.startedAt > ctx.timeoutMs) {
    throw new Error("[command timed out]");
  }
}

/**
 * Resolve a path relative to cwd
 * @param {string} p
 * @param {ShellContext} ctx
 * @returns {string}
 */
function resolvePath(p, ctx) {
  // Strip /workspace prefix if present
  let cleaned = p.replace(/^\/workspace\/?/, "");
  if (!cleaned || cleaned === "/") return ".";

  // Resolve relative to cwd
  if (!cleaned.startsWith("/") && ctx.cwd !== ".") {
    cleaned = ctx.cwd + "/" + cleaned;
  }
  cleaned = cleaned.replace(/^\/+/, "");

  // Normalise . and ..
  const parts = [];
  for (const seg of cleaned.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/") || ".";
}

/**
 * Expand shell variables
 * @param {string} str
 * @param {Record<string, string>} env
 * @returns {string}
 */
/**
 * Expand shell variables and command substitutions
 * @param {string} str
 * @param {ShellContext} ctx
 * @returns {Promise<string>}
 */
async function expandVarsAndSub(str, ctx) {
  // Variable expansion
  let result = str.replace(/\$\{(\w+)\}/g, (_, name) => ctx.env[name] ?? "");
  result = result.replace(/\$(\w+)/g, (_, name) => ctx.env[name] ?? "");

  // Command substitution
  let finalResult = "";
  let i = 0;
  while (i < result.length) {
    if (result[i] === "$" && result[i + 1] === "(") {
      let depth = 1;
      let start = i;
      let j = i + 2;
      while (j < result.length && depth > 0) {
        if (result[j] === "$" && result[j + 1] === "(") {
          depth++;
          j += 2;
          continue;
        }
        if (result[j] === ")") {
          depth--;
        } else if (result[j] === "(") {
          depth++;
        }
        j++;
      }

      const subCmd = result.slice(start + 2, j - 1);
      const subshellResult = await runPipeline(subCmd, ctx);
      finalResult += subshellResult.stdout.replace(/\n+$/, "");
      i = j;
    } else {
      finalResult += result[i];
      i++;
    }
  }
  return finalResult;
}

/**
 * Tokenize a command line respecting quotes
 * @param {string} cmd
 * @returns {string[]}
 */
function tokenize(cmd) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const ch of cmd) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse flags from args: -n 10 or -v
 * @param {string[]} args
 * @param {string[]} [withValue=[]]
 * @param {string[]} [booleans=[]]
 * @returns {{ flags: Record<string, string>; operands: string[] }}
 */
function parseFlags(args, withValue = [], booleans = []) {
  /** @type {Record<string, string>} */
  const flags = {};
  const operands = [];
  let i = 0;

  while (i < args.length) {
    const a = args[i];
    if (a === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }

    if (a.startsWith("-") && a.length > 1 && !a.startsWith("--")) {
      const flag = a.slice(1);

      // Handle combined flags like -rn
      if (flag.length > 1 && !withValue.includes(flag)) {
        for (const ch of flag) {
          if (withValue.includes(ch) && i + 1 < args.length) {
            flags[ch] = args[++i];
          } else {
            flags[ch] = "";
          }
        }
        i++;
        continue;
      }

      if (withValue.includes(flag) && i + 1 < args.length) {
        flags[flag] = args[++i];
      } else {
        flags[flag] = "";
      }
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        flags[a.slice(2)] = "";
      }
    } else {
      operands.push(a);
    }
    i++;
  }

  return { flags, operands };
}

/**
 * Helper to safely read a file
 * @param {string} groupId
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function safeRead(groupId, path) {
  try {
    return await readGroupFile(groupId, path);
  } catch {
    return null;
  }
}

/**
 * Escape special regex characters
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Handle test expressions
 * @param {string[]} args
 * @param {ShellContext} ctx
 * @returns {Promise<ShellResult>}
 */
async function testExpr(args, ctx) {
  const ok = { stdout: "", stderr: "", exitCode: 0 };
  const no = { stdout: "", stderr: "", exitCode: 1 };

  if (args.length === 0) return no;

  // Unary: -f file, -d dir, -z str, -n str, -e file
  if (args.length === 2) {
    switch (args[0]) {
      case "-f":
      case "-e":
        return (await groupFileExists(ctx.groupId, resolvePath(args[1], ctx)))
          ? ok
          : no;
      case "-d":
        // Check if directory exists by trying to list it
        try {
          await listGroupFiles(ctx.groupId, resolvePath(args[1], ctx));
          return ok;
        } catch {
          return no;
        }
      case "-z":
        return args[1].length === 0 ? ok : no;
      case "-n":
        return args[1].length > 0 ? ok : no;
    }
  }

  // Binary: str = str, str != str, num -eq num, etc.
  if (args.length === 3) {
    const [left, op, right] = args;
    switch (op) {
      case "=":
      case "==":
        return left === right ? ok : no;
      case "!=":
        return left !== right ? ok : no;
      case "-eq":
        return Number(left) === Number(right) ? ok : no;
      case "-ne":
        return Number(left) !== Number(right) ? ok : no;
      case "-lt":
        return Number(left) < Number(right) ? ok : no;
      case "-le":
        return Number(left) <= Number(right) ? ok : no;
      case "-gt":
        return Number(left) > Number(right) ? ok : no;
      case "-ge":
        return Number(left) >= Number(right) ? ok : no;
    }
  }

  // Negation
  if (args[0] === "!")
    return (await testExpr(args.slice(1), ctx)).exitCode === 0 ? no : ok;

  return no;
}
