/**
 * End-of-run resource account + mid-run HUD status renderers (pure string
 * assembly). Deterministic, human-readable, and drawn only from the shared
 * ledger so the user-facing answers are always derivable (spec section 19+20).
 */

import type { BudgetLevels, Pressure } from "./budget"
import type { ForecastVariance } from "./forecast"
import type { LedgerTotals } from "./ledger"

export type ResourceAccountInput = {
  variance: ForecastVariance
  totals: LedgerTotals
  levels: BudgetLevels
  avoidable: { label: string; tokens: number }[]
  most_expensive: string | null
}

export function renderResourceAccount(input: ResourceAccountInput): string {
  const { variance, totals, levels } = input
  const lines: string[] = []
  lines.push("RESOURCE ACCOUNT")
  lines.push("------------------------------------------------")

  const pct = (num: number): string => `${(num * 100).toFixed(0)}%`

  lines.push(
    `                            Expected          Actual`,
  )
  lines.push(`  Total tokens             ${fmt(variance.expected_tokens)}        ${fmt(variance.actual_tokens)}`)
  lines.push(`  Free tokens              -                 ${fmt(totals.total_free_tokens)}`)
  lines.push(`  Paid tokens              -                 ${fmt(totals.total_paid_tokens)}`)
  lines.push(`  Root tokens              -                 ${fmt(totals.total_root_tokens)}`)
  lines.push(`  Child tokens             -                 ${fmt(totals.total_child_tokens)}`)
  lines.push("")
  lines.push(`  Expected spend          $${variance.expected_paid_usd.toFixed(2)}`)
  lines.push(`  Actual/estimated spend  $${totals.total_cost_usd.toFixed(2)}`)
  lines.push(`  Hard ceiling            $${levels.hard_usd.toFixed(2)}`)
  lines.push("")
  const soft = levels.soft_usd > 0 ? totals.total_cost_usd / levels.soft_usd : 0
  lines.push(`  Budget consumed          ${pct(soft)}`)
  lines.push(`  Forecast error          ${variance.token_error >= 0 ? "+" : ""}${pct(variance.token_error)}`)
  lines.push(`  Context replication     ${fmt(totals.total_context_replication)} tokens`)
  lines.push(`  Most expensive          ${input.most_expensive ?? "n/a"}`)
  lines.push("")

  if (input.avoidable.length > 0) {
    lines.push("  Avoidable usage:")
    for (const a of input.avoidable) {
      lines.push(`    ${a.label}   ~${fmt(a.tokens)}`)
    }
  }
  lines.push("")
  lines.push(`  Remaining budget        $${Math.max(0, levels.hard_usd - totals.total_cost_usd).toFixed(2)}`)
  return lines.join("\n")
}

export type HudStatusInput = {
  spent_usd: number
  spent_tokens: number
  levels: BudgetLevels
  pressure: Pressure
  free_workers: number
  paid_workers: number
  context_tokens: number
  on_budget: boolean
}

export function renderHudStatus(input: HudStatusInput): string {
  const lines: string[] = []
  lines.push("Resource Governor")
  lines.push(`  paid: $${input.spent_usd.toFixed(2)} / $${input.levels.hard_usd.toFixed(2)}`)
  lines.push(`  tokens: ${fmt(input.spent_tokens)} / ${fmt(input.levels.hard_tokens)} hard`)
  lines.push(`  free workers: ${input.free_workers} active`)
  lines.push(`  paid workers: ${input.paid_workers} active`)
  lines.push(`  context: ${fmt(input.context_tokens)}`)
  lines.push(`  phase: ${input.pressure}`)
  lines.push(`  forecast: ${input.on_budget ? "on budget" : "over budget"}`)
  if (input.pressure === "high" || input.pressure === "critical") {
    lines.push(`  policy: free-only for new workers`)
  }
  if (input.pressure === "exhausted") {
    lines.push(`  policy: free-only; paid consumption blocked`)
  }
  return lines.join("\n")
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}
