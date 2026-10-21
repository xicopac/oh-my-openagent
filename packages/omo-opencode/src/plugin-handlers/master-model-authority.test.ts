import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelRoutingConfig } from "../config/schema"
import type { GovernanceAuditWriter } from "../shared/governance-audit"
import { PAID_MODEL_APPROVALS_FILENAME } from "../shared/paid-model-approvals"
import {
  applyConfiguredMasterModel,
  resolveConfiguredMasterModel,
} from "./master-model-authority"

const MASTER = "opencode/deepseek-v4.1-flash"
const FREE_MASTER = "opencode/nemotron-3.5-lightning-free"
const FREE_FALLBACK = "opencode/deepseek-v4.1-flash-free"
const STALE = "opencode/deepseek-v4-flash"

let home: string
const originalHome = process.env.HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omo-master-model-authority-"))
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

function routing(model: string = MASTER): ModelRoutingConfig {
  return {
    enabled: true,
    tiers: {
      master: { model, inherit_parent: false },
    },
  } as ModelRoutingConfig
}

type AuditEvent = { session: string; fields: Record<string, unknown> }

function makeAudit(): {
  audit: Pick<GovernanceAuditWriter, "write">
  events: AuditEvent[]
} {
  const events: AuditEvent[] = []
  return {
    events,
    audit: {
      write: (session, fields) => {
        events.push({ session, fields })
      },
    },
  }
}

function approvalsPath(): string {
  return join(home, ".omo", PAID_MODEL_APPROVALS_FILENAME)
}

function writeApprovals(models: string[]): void {
  mkdirSync(join(home, ".omo"), { recursive: true })
  writeFileSync(
    approvalsPath(),
    JSON.stringify({
      version: 1,
      approved: models.map((model) => ({
        model,
        approvedBy: "operator",
        approvedAt: "2026-10-21T10:00:00.000Z",
        reason: "incident exception",
      })),
    }),
    "utf8",
  )
}

function writeRawApprovals(contents: string): void {
  mkdirSync(join(home, ".omo"), { recursive: true })
  writeFileSync(approvalsPath(), contents, "utf8")
}

describe("#given an explicit master pin in model_routing", () => {
  test("#then it resolves as the authoritative master model", () => {
    expect(resolveConfiguredMasterModel(routing())).toBe(MASTER)
  })

  test("#when inherit_parent is omitted #then no master override is produced", () => {
    const config = { enabled: true, tiers: { master: { model: MASTER } } } as ModelRoutingConfig
    expect(resolveConfiguredMasterModel(config)).toBeUndefined()
  })

  test("#when inherit_parent is true #then no master override is produced", () => {
    const config = {
      enabled: true,
      tiers: { master: { model: MASTER, inherit_parent: true } },
    } as ModelRoutingConfig
    expect(resolveConfiguredMasterModel(config)).toBeUndefined()
  })

  test("#when the model is blank #then no master override is produced", () => {
    const config = {
      enabled: true,
      tiers: { master: { model: "   ", inherit_parent: false } },
    } as ModelRoutingConfig
    expect(resolveConfiguredMasterModel(config)).toBeUndefined()
  })

  test("#when model_routing is absent #then no master override is produced", () => {
    expect(resolveConfiguredMasterModel(undefined)).toBeUndefined()
  })
})

describe("#given a paid master with no approval file", () => {
  test("#when config loads #then the free equivalent is applied, never the paid model", () => {
    const config: Record<string, unknown> = { model: STALE }
    const { audit, events } = makeAudit()

    const applied = applyConfiguredMasterModel(config, { model_routing: routing() }, { audit })

    expect(applied).toBe(FREE_FALLBACK)
    expect(config.model).toBe(FREE_FALLBACK)
    expect(events).toHaveLength(1)
    expect(events[0]?.session).toBe("master-model-authority")
    expect(events[0]?.fields).toMatchObject({
      subsystem: "paid_model_gate",
      event: "paid_model_denied_fallback",
      requested_model: MASTER,
      applied_model: FREE_FALLBACK,
      reason: "approval_file_missing",
    })
  })

  test("#when the approval file is invalid #then the gate fails closed to the free equivalent", () => {
    writeRawApprovals("{ not json")
    const config: Record<string, unknown> = { model: STALE }
    const { audit, events } = makeAudit()

    const applied = applyConfiguredMasterModel(config, { model_routing: routing() }, { audit })

    expect(applied).toBe(FREE_FALLBACK)
    expect(config.model).toBe(FREE_FALLBACK)
    expect(events[0]?.fields.event).toBe("paid_model_denied_fallback")
    expect(events[0]?.fields.reason).toBe("approval_file_invalid")
  })

  test("#when no free fallback is configured #then config is not pointed at the paid model", () => {
    const config: Record<string, unknown> = { model: STALE }
    const { audit, events } = makeAudit()

    const applied = applyConfiguredMasterModel(
      config,
      { model_routing: routing() },
      { audit, freeFallbackModel: null },
    )

    expect(applied).toBeUndefined()
    expect(config.model).toBe(STALE)
    expect(events).toHaveLength(1)
    expect(events[0]?.fields).toMatchObject({
      event: "paid_model_denied_error",
      requested_model: MASTER,
      applied_model: null,
      reason: "no_free_fallback",
    })
  })
})

describe("#given a paid master with a recorded approval", () => {
  test("#when the exact model is approved #then the paid model is applied and audited", () => {
    writeApprovals([MASTER])
    const config: Record<string, unknown> = { model: STALE }
    const { audit, events } = makeAudit()

    const applied = applyConfiguredMasterModel(config, { model_routing: routing() }, { audit })

    expect(applied).toBe(MASTER)
    expect(config.model).toBe(MASTER)
    expect(events).toHaveLength(1)
    expect(events[0]?.fields).toMatchObject({
      subsystem: "paid_model_gate",
      event: "paid_model_approved_use",
      requested_model: MASTER,
      applied_model: MASTER,
      approved_by: "operator",
    })
  })

  test("#when a restart re-applies the same approved pin #then the result is stable and idempotent", () => {
    writeApprovals([MASTER])
    const config: Record<string, unknown> = { model: STALE }
    for (let index = 0; index < 3; index += 1) {
      applyConfiguredMasterModel(config, { model_routing: routing() }, { audit: makeAudit().audit })
    }
    expect(config.model).toBe(MASTER)
  })

  test("#when the approval names a different model #then the paid master falls back", () => {
    writeApprovals(["openai/other-paid"])
    const config: Record<string, unknown> = { model: STALE }
    const { audit, events } = makeAudit()

    const applied = applyConfiguredMasterModel(config, { model_routing: routing() }, { audit })

    expect(applied).toBe(FREE_FALLBACK)
    expect(events[0]?.fields.reason).toBe("approval_not_found")
  })
})

describe("#given a provably free master pin", () => {
  test("#when config loads #then it is applied without an approval file or audit event", () => {
    const config: Record<string, unknown> = { model: STALE }
    const { audit, events } = makeAudit()

    const applied = applyConfiguredMasterModel(
      config,
      { model_routing: routing(FREE_MASTER) },
      { audit },
    )

    expect(applied).toBe(FREE_MASTER)
    expect(config.model).toBe(FREE_MASTER)
    expect(events).toHaveLength(0)
  })
})

describe("#given no master pin", () => {
  test("#when the master is applied #then the existing model is left untouched", () => {
    const config: Record<string, unknown> = { model: STALE }
    const applied = applyConfiguredMasterModel(config, {})
    expect(applied).toBeUndefined()
    expect(config.model).toBe(STALE)
  })
})
