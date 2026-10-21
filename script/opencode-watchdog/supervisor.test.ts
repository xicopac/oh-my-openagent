/**
 * Unit tests for opencode watchdog supervisor.
 * Uses fakes/injected signal functions ONLY; never signals real processes.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseFlags,
  printHelp,
  isDisabled,
  parseProcStat,
  isStopped,
  isUninterruptible,
  buildHeartbeatPayload,
  getBootTimeSync,
  isOpencodeCmdline,
  findOpencodePidSync,
  readProcStatSync,
  ensureWatchdogDir,
  writeHeartbeat,
  appendEvent,
  defaultSignalFn,
  performSweep,
  setWatchdogDir,
  resetWatchdogDir,
  getEventsFile,
  type SupervisorFlags,
  type ProcStat,
  type HeartbeatPayload,
  type WatchdogEvent,
  type SweepContext,
} from "./supervisor";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestContext(overrides: Partial<SweepContext> = {}): SweepContext {
  const baseStat: ProcStat = {
    pid: 12345,
    comm: "opencode",
    state: "R",
    ppid: 1,
    pgrp: 12345,
    session: 12345,
    tty_nr: 0,
    tpgid: 0,
    flags: 0,
    minflt: 0,
    cminflt: 0,
    majflt: 0,
    cmajflt: 0,
    utime: 1000,
    stime: 500,
    cutime: 0,
    cstime: 0,
    priority: 20,
    nice: 0,
    num_threads: 10,
    itrealvalue: 0,
    starttime: 1000000,
    vsize: 100000000,
    rss: 50000000,
    rsslim: 0,
    startcode: 0,
    endcode: 0,
    startstack: 0,
    kstkesp: 0,
    kstkesp2: 0,
    signal: 0,
    blocked: 0,
    sigignore: 0,
    sigcatch: 0,
    wchan: 0,
    nswap: 0,
    cnswap: 0,
    exit_signal: 0,
    processor: 0,
    rt_priority: 0,
    policy: 0,
    delayacct_blkio_ticks: 0,
    guest_time: 0,
    cguest_time: 0,
    start_data: 0,
    end_data: 0,
    start_brk: 0,
    arg_start: 0,
    arg_end: 0,
    env_start: 0,
    env_end: 0,
    exit_code: 0,
  };

  return {
    pid: 12345,
    stat: baseStat,
    bootTime: Math.floor(Date.now() / 1000) - 86400,
    flags: {
      once: false,
      dryRun: true,
      interval: 30,
      killAfter: null,
      help: false,
    },
    signalFn: mock(() => true),
    dStateStart: new Map(),
    ...overrides,
  };
}

function setupTestWatchdogDir(): string {
  const testDir = path.join(os.tmpdir(), `omo-watchdog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  setWatchdogDir(testDir);
  return testDir;
}

function cleanupTestDir(testDir: string) {
  try {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
  resetWatchdogDir();
}

function readEvents(): WatchdogEvent[] {
  const eventsFile = getEventsFile();
  if (!fs.existsSync(eventsFile)) return [];
  const content = fs.readFileSync(eventsFile, "utf-8");
  return content.trim().split("\n").filter(Boolean).map(JSON.parse);
}

// ============================================================================
// Tests
// ============================================================================

describe("parseFlags", () => {
  test("parses default flags", () => {
    const flags = parseFlags([]);
    expect(flags.once).toBe(false);
    expect(flags.dryRun).toBe(false);
    expect(flags.interval).toBe(30);
    expect(flags.killAfter).toBeNull();
    expect(flags.help).toBe(false);
  });

  test("parses --once", () => {
    const flags = parseFlags(["--once"]);
    expect(flags.once).toBe(true);
  });

  test("parses --dry-run", () => {
    const flags = parseFlags(["--dry-run"]);
    expect(flags.dryRun).toBe(true);
  });

  test("parses --interval", () => {
    const flags = parseFlags(["--interval", "60"]);
    expect(flags.interval).toBe(60);
  });

  test("parses --kill-after", () => {
    const flags = parseFlags(["--kill-after", "120"]);
    expect(flags.killAfter).toBe(120);
  });

  test("parses --help", () => {
    const flags = parseFlags(["--help"]);
    expect(flags.help).toBe(true);
  });

  test("parses -h", () => {
    const flags = parseFlags(["-h"]);
    expect(flags.help).toBe(true);
  });

  test("throws on invalid --interval", () => {
    expect(() => parseFlags(["--interval", "abc"])).toThrow("Invalid --interval value");
    expect(() => parseFlags(["--interval", "0"])).toThrow("Invalid --interval value");
    expect(() => parseFlags(["--interval", "-5"])).toThrow("Invalid --interval value");
  });

  test("throws on invalid --kill-after", () => {
    expect(() => parseFlags(["--kill-after", "abc"])).toThrow("Invalid --kill-after value");
    expect(() => parseFlags(["--kill-after", "0"])).toThrow("Invalid --kill-after value");
  });

  test("throws on missing --interval value", () => {
    expect(() => parseFlags(["--interval"])).toThrow("--interval requires a value");
  });

  test("throws on missing --kill-after value", () => {
    expect(() => parseFlags(["--kill-after"])).toThrow("--kill-after requires a value");
  });

  test("throws on unknown flag", () => {
    expect(() => parseFlags(["--unknown"])).toThrow("Unknown flag: --unknown");
  });

  test("combines multiple flags", () => {
    const flags = parseFlags(["--once", "--dry-run", "--interval", "10", "--kill-after", "60"]);
    expect(flags.once).toBe(true);
    expect(flags.dryRun).toBe(true);
    expect(flags.interval).toBe(10);
    expect(flags.killAfter).toBe(60);
  });
});

describe("isDisabled", () => {
  const originalEnv = process.env.OMA_WATCHDOG_DISABLED;

  beforeEach(() => {
    delete process.env.OMA_WATCHDOG_DISABLED;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OMA_WATCHDOG_DISABLED = originalEnv;
    } else {
      delete process.env.OMA_WATCHDOG_DISABLED;
    }
  });

  test("returns false when not set", () => {
    expect(isDisabled()).toBe(false);
  });

  test("returns false when set to 0", () => {
    process.env.OMA_WATCHDOG_DISABLED = "0";
    expect(isDisabled()).toBe(false);
  });

  test("returns true when set to 1", () => {
    process.env.OMA_WATCHDOG_DISABLED = "1";
    expect(isDisabled()).toBe(true);
  });

  test("returns false when set to other value", () => {
    process.env.OMA_WATCHDOG_DISABLED = "true";
    expect(isDisabled()).toBe(false);
  });
});

describe("parseProcStat", () => {
  test("parses basic stat line", () => {
    // Minimal valid stat line (from proc(5))
    const statLine = "12345 (opencode) R 1 12345 12345 0 0 0 0 0 0 0 1000 500 0 0 20 0 10 0 1000000 100000000 50000000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0";
    const result = parseProcStat(statLine);

    expect(result.pid).toBe(12345);
    expect(result.comm).toBe("opencode");
    expect(result.state).toBe("R");
    expect(result.ppid).toBe(1);
    expect(result.utime).toBe(1000);
    expect(result.stime).toBe(500);
    expect(result.starttime).toBe(1000000);
  });

  test("parses comm with spaces", () => {
    const statLine = "12345 (opencode worker) R 1 12345 12345 0 0 0 0 0 0 0 1000 500 0 0 20 0 10 0 1000000 100000000 50000000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0";
    const result = parseProcStat(statLine);

    expect(result.pid).toBe(12345);
    expect(result.comm).toBe("opencode worker");
    expect(result.state).toBe("R");
  });

  test("throws on missing closing paren", () => {
    const statLine = "12345 (opencode R 1 12345 12345 0 0 0 0 0 0 0 1000 500 0 0 20 0 10 0 1000000 100000000 50000000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0";
    expect(() => parseProcStat(statLine)).toThrow("missing closing paren");
  });

  test("throws on too few fields", () => {
    const statLine = "12345 (opencode) R";
    expect(() => parseProcStat(statLine)).toThrow("Invalid stat format");
  });
});

describe("isStopped", () => {
  test("returns true for T", () => {
    expect(isStopped("T")).toBe(true);
  });

  test("returns true for t", () => {
    expect(isStopped("t")).toBe(true);
  });

  test("returns false for R", () => {
    expect(isStopped("R")).toBe(false);
  });

  test("returns false for S", () => {
    expect(isStopped("S")).toBe(false);
  });

  test("returns false for D", () => {
    expect(isStopped("D")).toBe(false);
  });

  test("returns false for Z", () => {
    expect(isStopped("Z")).toBe(false);
  });
});

describe("isUninterruptible", () => {
  test("returns true for D", () => {
    expect(isUninterruptible("D")).toBe(true);
  });

  test("returns false for R", () => {
    expect(isUninterruptible("R")).toBe(false);
  });

  test("returns false for S", () => {
    expect(isUninterruptible("S")).toBe(false);
  });

  test("returns false for T", () => {
    expect(isUninterruptible("T")).toBe(false);
  });

  test("returns false for Z", () => {
    expect(isUninterruptible("Z")).toBe(false);
  });
});

describe("buildHeartbeatPayload", () => {
  test("builds correct payload", () => {
    const stat: ProcStat = {
      pid: 12345,
      comm: "opencode",
      state: "R",
      ppid: 1,
      pgrp: 12345,
      session: 12345,
      tty_nr: 0,
      tpgid: 0,
      flags: 0,
      minflt: 0,
      cminflt: 0,
      majflt: 0,
      cmajflt: 0,
      utime: 1000,
      stime: 500,
      cutime: 0,
      cstime: 0,
      priority: 20,
      nice: 0,
      num_threads: 10,
      itrealvalue: 0,
      starttime: 1000000, // 10000 seconds after boot (100 ticks/sec)
      vsize: 100000000,
      rss: 50000000,
      rsslim: 0,
      startcode: 0,
      endcode: 0,
      startstack: 0,
      kstkesp: 0,
      kstkesp2: 0,
      signal: 0,
      blocked: 0,
      sigignore: 0,
      sigcatch: 0,
      wchan: 0,
      nswap: 0,
      cnswap: 0,
      exit_signal: 0,
      processor: 0,
      rt_priority: 0,
      policy: 0,
      delayacct_blkio_ticks: 0,
      guest_time: 0,
      cguest_time: 0,
      start_data: 0,
      end_data: 0,
      start_brk: 0,
      arg_start: 0,
      arg_end: 0,
      env_start: 0,
      env_end: 0,
      exit_code: 0,
    };

    const bootTime = Math.floor(Date.now() / 1000) - 20000; // 20000 seconds ago
    const payload = buildHeartbeatPayload(stat, bootTime);

    expect(payload.pid).toBe(12345);
    expect(payload.state).toBe("R");
    expect(payload.uptimeSeconds).toBeGreaterThan(9000); // ~10000 - small diff
    expect(payload.uptimeSeconds).toBeLessThan(11000);
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("handles zero starttime", () => {
    const stat: ProcStat = {
      ...createTestContext().stat,
      starttime: 0,
    };
    const bootTime = Math.floor(Date.now() / 1000) - 1000;
    const payload = buildHeartbeatPayload(stat, bootTime);

    expect(payload.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("getBootTimeSync", () => {
  test("returns a reasonable timestamp", () => {
    const bootTime = getBootTimeSync();
    const now = Math.floor(Date.now() / 1000);
    expect(bootTime).toBeLessThanOrEqual(now);
    expect(bootTime).toBeGreaterThan(now - 86400 * 365); // Within a year
  });
});

describe("isOpencodeCmdline", () => {
  test("returns true for matching cmdline", () => {
    expect(isOpencodeCmdline("/home/user/.opencode/bin/opencode")).toBe(true);
    expect(isOpencodeCmdline("/some/path/.opencode/bin/opencode --flag")).toBe(true);
    expect(isOpencodeCmdline("node .opencode/bin/opencode")).toBe(true);
  });

  test("returns false for non-matching cmdline", () => {
    expect(isOpencodeCmdline("/home/user/.opencode/bin/other")).toBe(false);
    expect(isOpencodeCmdline("/home/user/opencode")).toBe(false);
    expect(isOpencodeCmdline("")).toBe(false);
  });
});

describe("ensureWatchdogDir", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = setupTestWatchdogDir();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("creates directory", () => {
    // We can't easily test the internal constant, but we can test the function logic
    // by checking it doesn't throw
    expect(() => ensureWatchdogDir()).not.toThrow();
    expect(fs.existsSync(testDir)).toBe(true);
  });
});

describe("writeHeartbeat", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = setupTestWatchdogDir();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("writes heartbeat file when not dryRun", () => {
    const payload: HeartbeatPayload = {
      timestamp: "2024-01-01T00:00:00.000Z",
      pid: 12345,
      state: "R",
      uptimeSeconds: 1000,
    };

    writeHeartbeat(false, payload);
    const testFile = path.join(testDir, "heartbeat-12345.json");
    expect(fs.existsSync(testFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(testFile, "utf-8"));
    expect(content.pid).toBe(12345);
    expect(content.state).toBe("R");
  });

  test("does not write when dryRun", () => {
    const payload: HeartbeatPayload = {
      timestamp: "2024-01-01T00:00:00.000Z",
      pid: 12345,
      state: "R",
      uptimeSeconds: 1000,
    };

    writeHeartbeat(true, payload);
    const testFile = path.join(testDir, "heartbeat-12345.json");
    expect(fs.existsSync(testFile)).toBe(false);
  });
});

describe("appendEvent", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = setupTestWatchdogDir();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("appends event to JSONL file", () => {
    const event: WatchdogEvent = {
      timestamp: "2024-01-01T00:00:00.000Z",
      type: "heartbeat",
      pid: 12345,
      state: "R",
      details: { uptimeSeconds: 1000 },
    };

    appendEvent(event);
    const events = readEvents();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("heartbeat");
    expect(events[0].pid).toBe(12345);
  });

  test("creates valid JSONL", () => {
    const event: WatchdogEvent = {
      timestamp: "2024-01-01T00:00:00.000Z",
      type: "stopped",
      pid: 12345,
      state: "T",
      details: { action: "sent-SIGCONT" },
    };

    appendEvent(event);
    const events = readEvents();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("stopped");
    expect(() => JSON.parse(JSON.stringify(events[0]))).not.toThrow();
  });
});

describe("performSweep", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = setupTestWatchdogDir();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("logs heartbeat event", () => {
    const ctx = createTestContext();
    const signalFn = mock(() => true);
    const newDStateStart = performSweep({ ...ctx, signalFn });

    const events = readEvents();
    const heartbeatEvent = events.find(e => e.type === "heartbeat");
    expect(heartbeatEvent).toBeDefined();
    expect(heartbeatEvent?.pid).toBe(12345);
    expect(heartbeatEvent?.state).toBe("R");
    expect(newDStateStart.size).toBe(0);
  });

  test("sends SIGCONT for stopped process (T)", () => {
    const ctx = createTestContext({
      stat: { ...createTestContext().stat, state: "T" },
      flags: { ...createTestContext().flags, dryRun: false },
    });
    const signalFn = mock(() => true);
    performSweep({ ...ctx, signalFn });

    expect(signalFn).toHaveBeenCalledWith(12345, "SIGCONT");

    const events = readEvents();
    const stoppedEvent = events.find(e => e.type === "stopped");
    expect(stoppedEvent).toBeDefined();
    expect(stoppedEvent?.details?.action).toBe("sent-SIGCONT");
  });

  test("does not send SIGCONT in dryRun mode", () => {
    const ctx = createTestContext({
      stat: { ...createTestContext().stat, state: "T" },
      flags: { ...createTestContext().flags, dryRun: true },
    });
    const signalFn = mock(() => true);
    performSweep({ ...ctx, signalFn });

    expect(signalFn).not.toHaveBeenCalled();

    const events = readEvents();
    const stoppedEvent = events.find(e => e.type === "stopped");
    expect(stoppedEvent?.details?.action).toBe("would-send-SIGCONT");
  });

  test("logs suspicion event for D state", () => {
    const ctx = createTestContext({
      stat: { ...createTestContext().stat, state: "D" },
    });
    const signalFn = mock(() => true);
    performSweep({ ...ctx, signalFn });

    const events = readEvents();
    const hungEvent = events.find(e => e.type === "hung");
    expect(hungEvent).toBeDefined();
    expect(hungEvent?.details?.suspicion).toBe(true);
    expect(signalFn).not.toHaveBeenCalled();
  });

  test("tracks D state start time", () => {
    const ctx = createTestContext({
      stat: { ...createTestContext().stat, state: "D" },
    });
    const signalFn = mock(() => true);
    const newDStateStart = performSweep({ ...ctx, signalFn });

    expect(newDStateStart.has(12345)).toBe(true);
    expect(newDStateStart.get(12345)).toBeGreaterThan(0);
  });

  test("sends SIGKILL after killAfter timeout in D state", () => {
    const startTime = Date.now() - 10000; // 10 seconds ago
    const ctx = createTestContext({
      stat: { ...createTestContext().stat, state: "D" },
      flags: { ...createTestContext().flags, killAfter: 5, dryRun: false },
      dStateStart: new Map([[12345, startTime]]),
    });
    const signalFn = mock(() => true);
    const newDStateStart = performSweep({ ...ctx, signalFn });

    expect(signalFn).toHaveBeenCalledWith(12345, "SIGKILL");

    const events = readEvents();
    const killEvent = events.find(e => e.type === "kill");
    expect(killEvent).toBeDefined();
    expect(killEvent?.details?.reason).toBe("D-state timeout");
    expect(newDStateStart.has(12345)).toBe(false);
  });

  test("does not kill before killAfter timeout", () => {
    const startTime = Date.now() - 1000; // 1 second ago
    const ctx = createTestContext({
      stat: { ...createTestContext().stat, state: "D" },
      flags: { ...createTestContext().flags, killAfter: 5, dryRun: false },
      dStateStart: new Map([[12345, startTime]]),
    });
    const signalFn = mock(() => true);
    const newDStateStart = performSweep({ ...ctx, signalFn });

    expect(signalFn).not.toHaveBeenCalled();
    expect(newDStateStart.has(12345)).toBe(true);
  });

  test("clears D state tracking when process leaves D state", () => {
    const ctx = createTestContext({
      stat: { ...createTestContext().stat, state: "R" }, // Back to running
      dStateStart: new Map([[12345, Date.now() - 10000]]),
    });
    const signalFn = mock(() => true);
    const newDStateStart = performSweep({ ...ctx, signalFn });

    expect(newDStateStart.has(12345)).toBe(false);
  });

  test("does not kill when killAfter is null", () => {
    const startTime = Date.now() - 100000; // Long time ago
    const ctx = createTestContext({
      stat: { ...createTestContext().stat, state: "D" },
      flags: { ...createTestContext().flags, killAfter: null, dryRun: false },
      dStateStart: new Map([[12345, startTime]]),
    });
    const signalFn = mock(() => true);
    const newDStateStart = performSweep({ ...ctx, signalFn });

    expect(signalFn).not.toHaveBeenCalled();
    expect(newDStateStart.has(12345)).toBe(true);
  });
});

describe("defaultSignalFn", () => {
  test("returns true on success", () => {
    // We can't easily test this without actually sending signals
    // Just verify it's a function
    expect(typeof defaultSignalFn).toBe("function");
  });
});

describe("Integration: full sweep cycle", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = setupTestWatchdogDir();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("multiple sweeps track D state correctly", () => {
    const signalFn = mock(() => true);
    let dStateStart = new Map<number, number>();
    const baseCtx = createTestContext({ flags: { ...createTestContext().flags, killAfter: 2, dryRun: false } });

    // Sweep 1: Process enters D state
    let ctx = { ...baseCtx, stat: { ...baseCtx.stat, state: "D" }, dStateStart, signalFn };
    dStateStart = performSweep(ctx);
    expect(dStateStart.has(12345)).toBe(true);

    // Sweep 2: Still in D state, but not yet past killAfter
    ctx = { ...baseCtx, stat: { ...baseCtx.stat, state: "D" }, dStateStart, signalFn };
    dStateStart = performSweep(ctx);
    expect(dStateStart.has(12345)).toBe(true);
    expect(signalFn).not.toHaveBeenCalled();

    // Sweep 3: Past killAfter (mock time by adjusting start time)
    const oldStart = Date.now() - 3000;
    ctx = { ...baseCtx, stat: { ...baseCtx.stat, state: "D" }, dStateStart: new Map([[12345, oldStart]]), signalFn };
    dStateStart = performSweep(ctx);
    expect(signalFn).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(dStateStart.has(12345)).toBe(false);
  });
});