# Model Tiers (`model_tier`)

Per-delegation model capability tiers let the main orchestrator choose "how
powerful a model" runs a task independently of "what kind of work" (category or
subagent). The category or subagent stays in charge of persona, tools, skills,
permissions, and task behavior; the tier changes only the model that executes it.

## Tiers

| Tier | Intent |
|------|--------|
| `fast` | Low-risk mechanical work: search, grep, repository mapping, finding definitions/references, reading, tracing straightforward call chains, locating tests, documentation lookup. |
| `balanced` | Ordinary software engineering: contained features, bugs, unit tests, straightforward refactors, normal API/UI changes, config changes, unremarkable review. |
| `strong` | Substantial reasoning: difficult debugging, multi-module bugs, concurrency, state synchronization, schema migrations, performance, unfamiliar interacting systems, large refactors, security-sensitive work. |
| `master` | High-impact, used sparingly: architecture, cryptography, authz architecture, destructive infrastructure, subtle security boundaries, genuinely ambiguous design. Resolves to the current parent/main-session model. |

The objective is the cheapest tier with a high probability of success, not the
cheapest possible tier, and not a heavyweight tier for trivial work. Escalate
after genuine reasoning failures (`fast` -> `balanced` -> `strong` -> `master`).
Infrastructure errors (model not found, provider unavailable, rate limit) follow
availability fallback, not tier escalation.

## Usage

```typescript
task(subagent_type="explore", model_tier="fast", ...)
task(subagent_type="explore", model_tier="strong", ...)
task(category="deep", model_tier="strong", ...)
task(category="quick", model_tier="balanced", ...)
```

`model_tier` works for both `task(category=...)` and
`task(subagent_type=...)`. Omitting it preserves OMA's existing category/agent
model resolution.

## Configuration

```jsonc
{
  "[opencode]": {
    "model_routing": {
      "enabled": true,
      "tiers": {
        "fast": { "model": "opencode/nemotron-3.5-lightning-free" },
        "balanced": { "model": "opencode/mimo-v2.5-free" },
        "strong": { "model": "opencode/deepseek-v4-flash" },
        "master": { "inherit_parent": true }
      }
    }
  }
}
```

Each tier's `model` must be an exact registered model id in `provider/model`
form. The model registry is the source of truth; the resolver never fabricates
or prefixes a provider. `master.inher_parent: true` (the default) resolves to the
parent/main session's current model. If `master` has no parent model and no
configured model, resolution falls through to upstream OMA behavior.

## Resolution precedence

1. Explicit `model_tier` supplied by the parent/orchestrator.
2. Existing OMA category/agent/user model configuration.
3. Existing upstream OMA fallback/default behavior.

## Availability fallback

When a requested tier's model is unavailable in the live registry, resolution
escalates upward: `fast` -> `balanced` -> `strong` -> `master`, `balanced` ->
`strong` -> `master`, `strong` -> `master`. The fallback is logged (a concise
`[delegate-task] model_tier` line with the requested tier, resolved tier, model,
and escalation flag). No unrelated model is silently substituted.

## Fork maintenance

This fork adds the orthogonal `model_tier` capability on top of upstream
oh-my-openagent while keeping its orchestration architecture intact. To sync with
upstream:

```bash
git fetch upstream
git rebase upstream/dev
```

The patch is intentionally small: one schema field, one pure resolver
(`packages/delegate-core/src/model-tier.ts`), one config section
(`packages/omo-opencode/src/config/schema/model-routing.ts`), and minimal wiring
into `delegate-task`.
