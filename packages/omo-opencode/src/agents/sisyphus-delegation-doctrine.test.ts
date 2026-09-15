import { describe, expect, test } from "bun:test";
import { createSisyphusAgent } from "./sisyphus";
import {
  buildDelegationFirstExecutionDoctrine,
  DELEGATION_FIRST_EXECUTION_HEADING,
} from "./sisyphus-delegation-doctrine";

// These assertions target the LIVE composed prompt (createSisyphusAgent output),
// not a standalone string constant: they verify the doctrine is wired into the
// real Sisyphus system-prompt path. Markers are stable machine-consumable
// behavior keywords, not authored-prose snapshots or section-order contracts.

const FALLBACK_MODEL = "deepseek/deepseek-v4-pro";

const NATIVE_MODELS = [
  "anthropic/claude-opus-5",
  "openai/gpt-5.5",
  "zai/glm-5.2",
  "xai/grok-4.6",
  "opencode-go/kimi-k3",
];

describe("Sisyphus delegation-first doctrine", () => {
  test("#given any Sisyphus model #when baking the prompt #then the doctrine is prepended at the very top", () => {
    const doctrine = buildDelegationFirstExecutionDoctrine();

    for (const model of [FALLBACK_MODEL, ...NATIVE_MODELS]) {
      const prompt = createSisyphusAgent(model).prompt;

      expect(prompt.startsWith(doctrine), model).toBe(true);
      expect(prompt.indexOf(DELEGATION_FIRST_EXECUTION_HEADING), model).toBe(0);
    }
  });

  test("#when baking the live prompt #then it carries the orchestrator-not-worker identity", () => {
    const prompt = createSisyphusAgent(FALLBACK_MODEL).prompt;

    expect(prompt).toContain("You are the ORCHESTRATOR.");
    expect(prompt).toContain(
      "You are NOT the default repository explorer or implementation worker.",
    );
  });

  test("#when baking the live prompt #then it requires task-start delegation before broad exploration", () => {
    const prompt = createSisyphusAgent(FALLBACK_MODEL).prompt;

    expect(prompt).toContain(
      "For non-trivial repository tasks, dispatch worker(s) BEFORE broad repository exploration.",
    );
  });

  test("#when baking the live prompt #then repository discovery belongs to workers", () => {
    const prompt = createSisyphusAgent(FALLBACK_MODEL).prompt;

    expect(prompt).toContain("Workers should normally perform:");
    expect(prompt).toContain("- repository discovery");
    expect(prompt).toContain("- test-failure investigation");
    expect(prompt).toContain("- bounded implementation");
  });

  test("#when baking the live prompt #then MAIN direct work is a narrow exception", () => {
    const prompt = createSisyphusAgent(FALLBACK_MODEL).prompt;

    expect(prompt).toContain("MAIN DIRECT WORK IS AN EXCEPTION");
    expect(prompt).toContain("reading an exact worker-provided source anchor");
    expect(prompt).toContain("- one tiny known lookup");
  });

  test("#when baking the live prompt #then a weak worker refines/escalates instead of root takeover", () => {
    const prompt = createSisyphusAgent(FALLBACK_MODEL).prompt;

    expect(prompt).toContain("BAD WORKER RESULT != ROOT TAKEOVER");
    expect(prompt).toContain("improve worker assignments when results are weak");
    expect(prompt).toContain("Do NOT immediately take the work back.");
  });

  test("#when baking the live prompt #then escalation reaches a MAIN_EQUIVALENT child", () => {
    const prompt = createSisyphusAgent(FALLBACK_MODEL).prompt;

    expect(prompt).toContain("MAIN_EQUIVALENT");
    expect(prompt).toContain("MAIN_EQUIVALENT means a CHILD using MAIN's own model.");
  });

  test("#when baking the live prompt #then the deep-semantics justification is prohibited", () => {
    const prompt = createSisyphusAgent(FALLBACK_MODEL).prompt;

    expect(prompt).toContain('NO "DEEP SEMANTICS" LOOPHOLE');
    expect(prompt).toContain('"I need to read the core files myself for deep semantics."');
    expect(prompt).toContain("If deeper understanding is required: upgrade the WORKER.");
  });

  test("#when baking the live prompt #then a self-check precedes broad root tool use", () => {
    const prompt = createSisyphusAgent(FALLBACK_MODEL).prompt;

    expect(prompt).toContain("SELF-CHECK BEFORE ROOT TOOL USE");
    expect(prompt).toContain(
      '"Is this execution/retrieval work that a worker could perform?"',
    );
  });

  test("#when switching models through the factory #then native families carry the same doctrine", () => {
    const doctrine = buildDelegationFirstExecutionDoctrine();

    for (const model of NATIVE_MODELS) {
      const prompt = createSisyphusAgent(model).prompt;

      expect(prompt.startsWith(doctrine), model).toBe(true);
      expect(prompt).toContain("You are the ORCHESTRATOR.");
      expect(prompt).toContain("MAIN_EQUIVALENT");
    }
  });
});
