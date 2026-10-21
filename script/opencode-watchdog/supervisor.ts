#!/usr/bin/env bun
/**
 * External opencode watchdog supervisor.
 * Defense-in-depth for process-level hangs the in-process watchdog cannot handle.
 * Log-only by default; never kills unless explicitly enabled via --kill-after.
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface SupervisorFlags {
  once: boolean;
  dryRun: boolean;
  interval: number;
  killAfter: number | null;
  help: boolean;
}

export interface ProcStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  pgrp: number;
  session: number;
  tty_nr: number;
  tpgid: number;
  flags: number;
  minflt: number;
  cminflt: number;
  majflt: number;
  cmajflt: number;
  utime: number;
  stime: number;
  cutime: number;
  cstime: number;
  priority: number;
  nice: number;
  num_threads: number;
  itrealvalue: number;
  starttime: number;
  vsize: number;
  rss: number;
  rsslim: number;
  startcode: number;
  endcode: number;
  startstack: number;
  kstkesp: number;
  kstkesp2: number; // kstkeip in older kernels
  signal: number;
  blocked: number;
  sigignore: number;
  sigcatch: number;
  wchan: number;
  nswap: number;
  cnswap: number;
  exit_signal: number;
  processor: number;
  rt_priority: number;
  policy: number;
  delayacct_blkio_ticks: number;
  guest_time: number;
  cguest_time: number;
  start_data: number;
  end_data: number;
  start_brk: number;
  arg_start: number;
  arg_end: number;
  env_start: number;
  env_end: number;
  exit_code: number;
}

export interface HeartbeatPayload {
  timestamp: string;
  pid: number;
  state: string;
  uptimeSeconds: number;
}

export interface WatchdogEvent {
  timestamp: string;
  type: "heartbeat" | "stopped" | "hung" | "kill" | "startup" | "shutdown";
  pid: number;
  state?: string;
  details?: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_WATCHDOG_DIR = join(homedir(), ".omo", "watchdog");
const HEARTBEAT_PREFIX = "heartbeat-";
const EVENTS_FILE_NAME = "events.jsonl";
const OPENCODE_CMDLINE_MATCH = ".opencode/bin/opencode";
const DEFAULT_INTERVAL = 30;
const CLOCK_TICKS_PER_SEC = 100; // sysconf(_SC_CLK_TCK) typically 100 on Linux

// Configurable for testing
let watchdogDir = DEFAULT_WATCHDOG_DIR;
let eventsFile = join(watchdogDir, EVENTS_FILE_NAME);

/**
 * Set watchdog directory (for testing).
 */
export function setWatchdogDir(dir: string): void {
  watchdogDir = dir;
  eventsFile = join(watchdogDir, EVENTS_FILE_NAME);
}

/**
 * Get current watchdog directory.
 */
export function getWatchdogDir(): string {
  return watchdogDir;
}

/**
 * Get current events file path.
 */
export function getEventsFile(): string {
  return eventsFile;
}

/**
 * Reset watchdog directory to default (for testing).
 */
export function resetWatchdogDir(): void {
  watchdogDir = DEFAULT_WATCHDOG_DIR;
  eventsFile = join(watchdogDir, EVENTS_FILE_NAME);
}

// ============================================================================
// Pure Functions (exported for testing)
// ============================================================================

/**
 * Parse command line flags.
 */
export function parseFlags(args: string[]): SupervisorFlags {
  const flags: SupervisorFlags = {
    once: false,
    dryRun: false,
    interval: DEFAULT_INTERVAL,
    killAfter: null,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--once":
        flags.once = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--interval":
        if (i + 1 < args.length) {
          const val = parseInt(args[++i], 10);
          if (isNaN(val) || val <= 0) {
            throw new Error(`Invalid --interval value: ${args[i]}`);
          }
          flags.interval = val;
        } else {
          throw new Error("--interval requires a value");
        }
        break;
      case "--kill-after":
        if (i + 1 < args.length) {
          const val = parseInt(args[++i], 10);
          if (isNaN(val) || val <= 0) {
            throw new Error(`Invalid --kill-after value: ${args[i]}`);
          }
          flags.killAfter = val;
        } else {
          throw new Error("--kill-after requires a value");
        }
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }
  return flags;
}

/**
 * Print help message.
 */
export function printHelp(): void {
  console.log(`
External opencode watchdog supervisor.

Usage: bun script/opencode-watchdog/supervisor.ts [options]

Options:
  --once              Single sweep then exit
  --dry-run           No signals sent, no heartbeat files written; events still logged
  --interval <sec>    Sweep interval in seconds (default: 30)
  --kill-after <sec>  DANGEROUS: Send SIGKILL after process stays in D state for N seconds.
                      DEFAULT OFF. Use with extreme caution - can cause data loss.
  --help, -h          Show this help

Environment:
  OMA_WATCHDOG_DISABLED=1  Exit immediately with code 0 (disable watchdog)

Behavior:
  - Scans /proc for opencode process (matches ".opencode/bin/opencode" in cmdline)
  - Writes heartbeat JSON to ~/.omo/watchdog/heartbeat-<pid>.json each sweep
  - Appends JSONL events to ~/.omo/watchdog/events.jsonl
  - Stopped process (state T) -> SIGCONT (unless --dry-run)
  - Hung/uninterruptible (state D) persisting -> suspicion event only (never kills by default)
  - With --kill-after: sends SIGKILL after D state persists for specified seconds
`);
}

/**
 * Check if watchdog is disabled via environment variable.
 */
export function isDisabled(): boolean {
  return process.env.OMA_WATCHDOG_DISABLED === "1";
}

/**
 * Parse /proc/<pid>/stat content into a structured object.
 * See proc(5) man page for field descriptions.
 */
export function parseProcStat(content: string): ProcStat {
  // The comm field (index 1) is in parentheses and may contain spaces.
  // Find the closing paren to split properly.
  const closeParenIdx = content.lastIndexOf(")");
  if (closeParenIdx === -1) {
    throw new Error("Invalid stat format: missing closing paren for comm");
  }

  const beforeComm = content.slice(0, content.indexOf("("));
  const comm = content.slice(content.indexOf("(") + 1, closeParenIdx);
  const afterComm = content.slice(closeParenIdx + 1).trim();

  const parts = beforeComm.trim().split(/\s+/);
  const afterParts = afterComm.split(/\s+/);

  if (parts.length < 1 || afterParts.length < 49) {
    throw new Error(`Invalid stat format: expected at least 51 fields, got ${parts.length + 1 + afterParts.length}`);
  }

  const pid = parseInt(parts[0], 10);

  return {
    pid,
    comm,
    state: afterParts[0],
    ppid: parseInt(afterParts[1], 10),
    pgrp: parseInt(afterParts[2], 10),
    session: parseInt(afterParts[3], 10),
    tty_nr: parseInt(afterParts[4], 10),
    tpgid: parseInt(afterParts[5], 10),
    flags: parseInt(afterParts[6], 10),
    minflt: parseInt(afterParts[7], 10),
    cminflt: parseInt(afterParts[8], 10),
    majflt: parseInt(afterParts[9], 10),
    cmajflt: parseInt(afterParts[10], 10),
    utime: parseInt(afterParts[11], 10),
    stime: parseInt(afterParts[12], 10),
    cutime: parseInt(afterParts[13], 10),
    cstime: parseInt(afterParts[14], 10),
    priority: parseInt(afterParts[15], 10),
    nice: parseInt(afterParts[16], 10),
    num_threads: parseInt(afterParts[17], 10),
    itrealvalue: parseInt(afterParts[18], 10),
    starttime: parseInt(afterParts[19], 10),
    vsize: parseInt(afterParts[20], 10),
    rss: parseInt(afterParts[21], 10),
    rsslim: parseInt(afterParts[22], 10),
    startcode: parseInt(afterParts[23], 10),
    endcode: parseInt(afterParts[24], 10),
    startstack: parseInt(afterParts[25], 10),
    kstkesp: parseInt(afterParts[26], 10),
    kstkesp2: parseInt(afterParts[27], 10),
    signal: parseInt(afterParts[28], 10),
    blocked: parseInt(afterParts[29], 10),
    sigignore: parseInt(afterParts[30], 10),
    sigcatch: parseInt(afterParts[31], 10),
    wchan: parseInt(afterParts[32], 10),
    nswap: parseInt(afterParts[33], 10),
    cnswap: parseInt(afterParts[34], 10),
    exit_signal: parseInt(afterParts[35], 10),
    processor: parseInt(afterParts[36], 10),
    rt_priority: parseInt(afterParts[37], 10),
    policy: parseInt(afterParts[38], 10),
    delayacct_blkio_ticks: parseInt(afterParts[39], 10),
    guest_time: parseInt(afterParts[40], 10),
    cguest_time: parseInt(afterParts[41], 10),
    start_data: parseInt(afterParts[42], 10),
    end_data: parseInt(afterParts[43], 10),
    start_brk: parseInt(afterParts[44], 10),
    arg_start: parseInt(afterParts[45], 10),
    arg_end: parseInt(afterParts[46], 10),
    env_start: parseInt(afterParts[47], 10),
    env_end: parseInt(afterParts[48], 10),
    exit_code: afterParts.length > 49 ? parseInt(afterParts[49], 10) : 0,
  };
}

/**
 * Check if process state indicates stopped (T/t).
 */
export function isStopped(state: string): boolean {
  return state === "T" || state === "t";
}

/**
 * Check if process state indicates uninterruptible sleep (D).
 */
export function isUninterruptible(state: string): boolean {
  return state === "D";
}

/**
 * Build heartbeat payload from process stat.
 */
export function buildHeartbeatPayload(stat: ProcStat, bootTimeSec: number): HeartbeatPayload {
  const now = Date.now();
  const startTimeSec = stat.starttime / CLOCK_TICKS_PER_SEC;
  const uptimeSeconds = (now / 1000) - (bootTimeSec + startTimeSec);

  return {
    timestamp: new Date(now).toISOString(),
    pid: stat.pid,
    state: stat.state,
    uptimeSeconds: Math.max(0, uptimeSeconds),
  };
}

/**
 * Get system boot time in seconds since epoch.
 * Reads from /proc/stat (btime field).
 */
export function getBootTime(): number {
  try {
    const content = Bun.file("/proc/stat").text();
    // This is async, but we need sync for the pure function.
    // We'll handle this differently in the main loop.
    return 0; // Placeholder, actual implementation uses sync read
  } catch {
    return Math.floor(Date.now() / 1000) - 86400; // Fallback: assume 1 day uptime
  }
}

/**
 * Get system boot time synchronously.
 */
export function getBootTimeSync(): number {
  try {
    const content = require("node:fs").readFileSync("/proc/stat", "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("btime ")) {
        return parseInt(line.slice(6).trim(), 10);
      }
    }
  } catch {
    // Ignore errors
  }
  return Math.floor(Date.now() / 1000) - 86400;
}

/**
 * Check if cmdline matches opencode.
 */
export function isOpencodeCmdline(cmdline: string): boolean {
  return cmdline.includes(OPENCODE_CMDLINE_MATCH);
}

/**
 * Find opencode process by scanning /proc.
 * Returns PID if found, null otherwise.
 */
export function findOpencodePidSync(): number | null {
  try {
    const entries = require("node:fs").readdirSync("/proc");
    for (const entry of entries) {
      const pid = parseInt(entry, 10);
      if (isNaN(pid)) continue;

      try {
        const cmdlinePath = `/proc/${pid}/cmdline`;
        const cmdline = require("node:fs").readFileSync(cmdlinePath, "utf-8");
        if (isOpencodeCmdline(cmdline)) {
          return pid;
        }
      } catch {
        // Process may have exited, ignore
      }
    }
  } catch {
    // /proc not accessible
  }
  return null;
}

/**
 * Read and parse /proc/<pid>/stat synchronously.
 */
export function readProcStatSync(pid: number): ProcStat | null {
  try {
    const content = require("node:fs").readFileSync(`/proc/${pid}/stat`, "utf-8");
    return parseProcStat(content);
  } catch {
    return null;
  }
}

/**
 * Ensure watchdog directory exists.
 */
export function ensureWatchdogDir(): void {
  if (!existsSync(watchdogDir)) {
    mkdirSync(watchdogDir, { recursive: true });
  }
}

/**
 * Write heartbeat file.
 */
export function writeHeartbeat(dryRun: boolean, payload: HeartbeatPayload): void {
  if (dryRun) return;
  ensureWatchdogDir();
  const filepath = join(watchdogDir, `${HEARTBEAT_PREFIX}${payload.pid}.json`);
  writeFileSync(filepath, JSON.stringify(payload, null, 2));
}

/**
 * Append event to JSONL log.
 */
export function appendEvent(event: WatchdogEvent): void {
  ensureWatchdogDir();
  const line = JSON.stringify(event) + "\n";
  appendFileSync(eventsFile, line);
}

/**
 * Send signal to process (injected for testing).
 */
export type SignalFn = (pid: number, signal: string) => boolean;

/**
 * Default signal implementation using process.kill.
 */
export function defaultSignalFn(pid: number, signal: string): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Main sweep logic - pure function for testing.
 */
export interface SweepContext {
  pid: number;
  stat: ProcStat;
  bootTime: number;
  flags: SupervisorFlags;
  signalFn: SignalFn;
  dStateStart: Map<number, number>; // pid -> timestamp when D state first seen
}

export function performSweep(ctx: SweepContext): Map<number, number> {
  const { pid, stat, bootTime, flags, signalFn, dStateStart } = ctx;
  const newDStateStart = new Map(dStateStart);

  // Build and write heartbeat
  const heartbeat = buildHeartbeatPayload(stat, bootTime);
  writeHeartbeat(flags.dryRun, heartbeat);

  // Log heartbeat event
  appendEvent({
    timestamp: heartbeat.timestamp,
    type: "heartbeat",
    pid: heartbeat.pid,
    state: heartbeat.state,
    details: { uptimeSeconds: heartbeat.uptimeSeconds },
  });

  // Check for stopped state (T/t)
  if (isStopped(stat.state)) {
    appendEvent({
      timestamp: new Date().toISOString(),
      type: "stopped",
      pid,
      state: stat.state,
      details: { action: flags.dryRun ? "would-send-SIGCONT" : "sent-SIGCONT" },
    });
    if (!flags.dryRun) {
      signalFn(pid, "SIGCONT");
    }
  }

  // Check for uninterruptible sleep (D)
  if (isUninterruptible(stat.state)) {
    const now = Date.now();
    if (!newDStateStart.has(pid)) {
      newDStateStart.set(pid, now);
      appendEvent({
        timestamp: new Date(now).toISOString(),
        type: "hung",
        pid,
        state: stat.state,
        details: { suspicion: true, killAfter: flags.killAfter },
      });
    } else if (flags.killAfter !== null) {
      const startTime = newDStateStart.get(pid)!;
      const elapsed = (now - startTime) / 1000;
      if (elapsed >= flags.killAfter) {
        appendEvent({
          timestamp: new Date(now).toISOString(),
          type: "kill",
          pid,
          state: stat.state,
          details: { reason: "D-state timeout", elapsedSeconds: elapsed },
        });
        if (!flags.dryRun) {
          signalFn(pid, "SIGKILL");
        }
        newDStateStart.delete(pid);
      }
    }
  } else {
    // Process left D state
    if (newDStateStart.has(pid)) {
      newDStateStart.delete(pid);
    }
  }

  return newDStateStart;
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<number> {
  // Check disabled flag first
  if (isDisabled()) {
    return 0;
  }

  const flags = parseFlags(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return 0;
  }

  ensureWatchdogDir();

  // Log startup
  appendEvent({
    timestamp: new Date().toISOString(),
    type: "startup",
    pid: process.pid,
    details: { flags: { once: flags.once, dryRun: flags.dryRun, interval: flags.interval, killAfter: flags.killAfter } },
  });

  const bootTime = getBootTimeSync();
  let dStateStart = new Map<number, number>();
  const signalFn = defaultSignalFn;

  try {
    while (true) {
      const pid = findOpencodePidSync();
      if (pid !== null) {
        const stat = readProcStatSync(pid);
        if (stat !== null) {
          dStateStart = performSweep({
            pid,
            stat,
            bootTime,
            flags,
            signalFn,
            dStateStart,
          });
        }
      }

      if (flags.once) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, flags.interval * 1000));
    }
  } catch (error) {
    appendEvent({
      timestamp: new Date().toISOString(),
      type: "shutdown",
      pid: process.pid,
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }

  // Log shutdown
  appendEvent({
    timestamp: new Date().toISOString(),
    type: "shutdown",
    pid: process.pid,
    details: { reason: flags.once ? "once-complete" : "unknown" },
  });

  return 0;
}

// Run if executed directly
if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}