import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_FREE_FALLBACK_MODEL,
  PAID_MODEL_APPROVALS_FILENAME,
  decidePaidModelUse,
  isProvablyFreeModel,
  readPaidModelApprovals,
  resolvePaidModelApprovalsPath,
  type PaidModelApproval,
} from "./paid-model-approvals"

const PAID = "opencode/deepseek-v4.1-flash"
const FREE = "opencode/deepseek-v4.1-flash-free"
const OTHER_PAID = "openai/paid-strong"

let home: string
const originalHome = process.env.HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omo-paid-model-approvals-"))
  process.env.HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
})

function omoDir(): string {
  return join(home, ".omo")
}

function approvalsPath(): string {
  return join(omoDir(), PAID_MODEL_APPROVALS_FILENAME)
}

function approval(model: string, overrides: Partial<PaidModelApproval> = {}): PaidModelApproval {
  return {
    model,
    approvedBy: "operator",
    approvedAt: "2026-10-21T10:00:00.000Z",
    reason: "approved exception",
    ...overrides,
  }
}

function writeApprovalsFile(value: unknown): string {
  mkdirSync(omoDir(), { recursive: true })
  const path = approvalsPath()
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), "utf8")
  return path
}

describe("#given model ids with different cost signals", () => {
  test("#then only explicit known-free ids and -free/:free suffixes are provably free", () => {
    expect(isProvablyFreeModel(FREE)).toBe(true)
    expect(isProvablyFreeModel("opencode/nemotron-3.5-lightning-free")).toBe(true)
    expect(isProvablyFreeModel("openrouter/some-model:free")).toBe(true)
    expect(isProvablyFreeModel(PAID)).toBe(false)
    expect(isProvablyFreeModel(OTHER_PAID)).toBe(false)
    expect(isProvablyFreeModel("opencode/unknown-cost")).toBe(false)
    expect(isProvablyFreeModel(undefined)).toBe(false)
    expect(isProvablyFreeModel("   ")).toBe(false)
  })
})

describe("#given a temp HOME", () => {
  test("#when resolving the approval path #then it lives under ~/.omo", () => {
    expect(resolvePaidModelApprovalsPath()).toBe(approvalsPath())
  })
})

describe("#given no approval file", () => {
  test("#when reading #then the snapshot is missing", () => {
    expect(readPaidModelApprovals()).toEqual({ status: "missing", path: approvalsPath() })
  })

  test("#when a paid master is requested #then it falls back to the free equivalent", () => {
    const decision = decidePaidModelUse({ requestedModel: PAID })
    expect(decision).toEqual({
      action: "deny_fallback",
      requestedModel: PAID,
      fallbackModel: DEFAULT_FREE_FALLBACK_MODEL,
      reason: "approval_file_missing",
      detail: `no approval file at ${approvalsPath()}`,
    })
  })

  test("#when no free fallback is configured #then the gate fails closed", () => {
    const decision = decidePaidModelUse({ requestedModel: PAID, freeFallbackModel: null })
    expect(decision.action).toBe("deny_error")
    if (decision.action === "deny_error") {
      expect(decision.reason).toBe("no_free_fallback")
      expect(decision.message).toContain("PAID_MODEL_APPROVAL_REQUIRED")
    }
  })

  test("#when the configured fallback is itself paid #then the gate fails closed", () => {
    const decision = decidePaidModelUse({ requestedModel: PAID, freeFallbackModel: OTHER_PAID })
    expect(decision.action).toBe("deny_error")
    if (decision.action === "deny_error") expect(decision.reason).toBe("fallback_not_free")
  })
})

describe("#given a provably free model", () => {
  test("#when it is requested #then no approval file is needed", () => {
    const decision = decidePaidModelUse({ requestedModel: FREE })
    expect(decision).toEqual({ action: "allow_free", model: FREE })
  })
})

describe("#given an approval file", () => {
  test("#when it is malformed JSON #then the gate treats it as invalid and falls back", () => {
    writeApprovalsFile("{ not json")
    const snapshot = readPaidModelApprovals()
    expect(snapshot.status).toBe("invalid")
    const decision = decidePaidModelUse({ requestedModel: PAID })
    expect(decision.action).toBe("deny_fallback")
    if (decision.action === "deny_fallback") expect(decision.reason).toBe("approval_file_invalid")
  })

  test("#when the version is unsupported #then the gate treats it as invalid", () => {
    writeApprovalsFile({ version: 2, approved: [approval(PAID)] })
    expect(readPaidModelApprovals().status).toBe("invalid")
    const decision = decidePaidModelUse({ requestedModel: PAID })
    if (decision.action !== "deny_fallback") throw new Error("expected fallback")
    expect(decision.reason).toBe("approval_file_invalid")
  })

  test("#when the requested model has an exact approval #then the paid model is allowed", () => {
    writeApprovalsFile({ version: 1, approved: [approval(PAID)] })
    const decision = decidePaidModelUse({ requestedModel: PAID })
    expect(decision.action).toBe("allow_approved_paid")
    if (decision.action === "allow_approved_paid") {
      expect(decision.approval.model).toBe(PAID)
      expect(decision.approval.approvedBy).toBe("operator")
    }
  })

  test("#when the approval is for another model #then the gate falls back", () => {
    writeApprovalsFile({ version: 1, approved: [approval(OTHER_PAID)] })
    const decision = decidePaidModelUse({ requestedModel: PAID })
    expect(decision.action).toBe("deny_fallback")
    if (decision.action === "deny_fallback") expect(decision.reason).toBe("approval_not_found")
  })

  test("#when an entry is malformed #then it cannot authorize the model", () => {
    writeApprovalsFile({
      version: 1,
      approved: [{ model: PAID, approvedBy: "", approvedAt: "not-a-date", reason: "" }],
    })
    const snapshot = readPaidModelApprovals()
    expect(snapshot.status).toBe("ok")
    if (snapshot.status === "ok") expect(snapshot.approvals).toHaveLength(0)
    const decision = decidePaidModelUse({ requestedModel: PAID })
    expect(decision.action).toBe("deny_fallback")
  })

  test("#when the requested model is absent from approved[] #then no paid allow is possible", () => {
    writeApprovalsFile({ version: 1, approved: [] })
    const decision = decidePaidModelUse({ requestedModel: PAID })
    expect(decision.action).toBe("deny_fallback")
  })
})
