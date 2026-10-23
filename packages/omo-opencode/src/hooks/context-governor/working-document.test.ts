import { describe, expect, test } from "bun:test"
import {
  buildWorkingDocument,
  DEFAULT_WORKING_DOCUMENT_TOKENS,
  type HistoryEntry,
} from "./working-document"

function makeHistory(count: number, textLength = 200): HistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message ${index} ${"x".repeat(textLength)}`,
  }))
}

describe("buildWorkingDocument", () => {
  test("large history is referenced, not inlined, with the correct range and count", () => {
    // given
    const history = makeHistory(200)

    // when
    const doc = buildWorkingDocument({
      objective: "Fix the context governor",
      constraints: ["No paid models"],
      nextAction: "Run the tests",
      history,
    })

    // then
    expect(doc.historyRef).toBeDefined()
    expect(doc.historyRef?.startIndex).toBe(0)
    expect(doc.historyRef?.endIndex).toBe(199)
    expect(doc.historyRef?.count).toBe(200)
    expect(doc.historyRef?.retrievalId.length).toBeGreaterThan(0)
    expect(doc.text).toContain("History:")
    expect(doc.text).not.toContain("x".repeat(200))
    expect(doc.text).not.toContain("message 100")
  })

  test("large input stays within the token budget and reports truncation", () => {
    // given
    const history = makeHistory(200)

    // when
    const doc = buildWorkingDocument({
      objective: "Audit the module",
      constraints: ["Stay in context-governor", "No network"],
      decisions: ["Use estimateTokens"],
      artifacts: ["src/hooks/context-governor/working-document.ts"],
      history,
      maxTokens: 400,
    })

    // then
    expect(doc.estimatedTokens).toBeLessThanOrEqual(400)
    expect(doc.text.length).toBeLessThanOrEqual(400 * 4)
    expect(doc.truncated).toBe(true)
  })

  test("small input is not truncated and retains every section", () => {
    // given
    const history: HistoryEntry[] = [
      { id: "m1", text: "hello" },
      { id: "m2", text: "world" },
    ]

    // when
    const doc = buildWorkingDocument({
      objective: "Ship the fix",
      constraints: ["No paid models"],
      phase: "implementation",
      nextAction: "Write tests",
      decisions: ["Keep the module pure"],
      artifacts: ["src/hooks/context-governor/working-document.ts"],
      history,
    })

    // then
    expect(DEFAULT_WORKING_DOCUMENT_TOKENS).toBeGreaterThanOrEqual(800)
    expect(DEFAULT_WORKING_DOCUMENT_TOKENS).toBeLessThanOrEqual(1200)
    expect(doc.truncated).toBe(false)
    expect(doc.text).toContain("Objective: Ship the fix")
    expect(doc.text).toContain("Constraints:")
    expect(doc.text).toContain("No paid models")
    expect(doc.text).toContain("Phase: implementation")
    expect(doc.text).toContain("Next action: Write tests")
    expect(doc.text).toContain("Decisions:")
    expect(doc.text).toContain("Artifacts:")
    expect(doc.text).toContain("src/hooks/context-governor/working-document.ts")
    expect(doc.historyRef?.count).toBe(2)
    expect(doc.text).toContain("History:")
    expect(doc.estimatedTokens).toBeLessThanOrEqual(DEFAULT_WORKING_DOCUMENT_TOKENS)
  })

  test("unique artifact references survive aggressive truncation", () => {
    // given
    const artifacts = [
      "src/hooks/context-governor/working-document.ts",
      "src/hooks/context-governor/budget-policy.ts",
      "src/hooks/context-governor/context-payload-budget.ts",
      "src/hooks/context-governor/working-document.test.ts",
      "src/hooks/context-governor/budget-policy.test.ts",
      "src/hooks/context-governor/context-payload-budget.test.ts",
    ]

    // when
    const doc = buildWorkingDocument({
      objective: "y".repeat(20_000),
      constraints: ["No paid models", "No network"],
      nextAction: "Run bun test",
      decisions: ["d".repeat(2_000)],
      artifacts,
      history: makeHistory(200),
      maxTokens: 400,
    })

    // then
    expect(doc.estimatedTokens).toBeLessThanOrEqual(400)
    expect(doc.truncated).toBe(true)
    for (const artifact of artifacts) {
      expect(doc.text).toContain(artifact)
    }
    expect(doc.artifacts).toEqual(artifacts)
  })

  test("duplicate constraints, decisions, and artifacts are collapsed deterministically", () => {
    // given
    const input = {
      objective: "Dedupe",
      constraints: ["no paid models", "no paid models"],
      decisions: ["keep pure", "keep pure"],
      artifacts: ["a.ts", "a.ts", "b.ts"],
    } as const

    // when
    const doc = buildWorkingDocument(input)

    // then
    expect(doc.constraints).toEqual(["no paid models"])
    expect(doc.decisions).toEqual(["keep pure"])
    expect(doc.artifacts).toEqual(["a.ts", "b.ts"])
    expect(doc.truncated).toBe(true)
  })

  test("deterministic output for identical input", () => {
    // given
    const input = {
      objective: "Determinism",
      constraints: ["c1", "c2"],
      phase: "review",
      nextAction: "Report",
      decisions: ["d1"],
      artifacts: ["file.ts"],
      history: makeHistory(200),
      maxTokens: 500,
    } as const

    // when
    const first = buildWorkingDocument(input)
    const second = buildWorkingDocument(input)

    // then
    expect(first).toEqual(second)
    expect(first.text).toBe(second.text)
  })
})
