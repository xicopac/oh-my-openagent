#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible mock provider for the OMA E2E routing
 * harness. Speaks the `@ai-sdk/openai-compatible` protocol (/v1/chat/completions,
 * streaming SSE). Everything is scripted from the request body: no model call,
 * no network, no paid provider.
 *
 * Scripted models (provider "test"):
 *   test/root               — the MAIN/root model. Scripted multi-turn behavior
 *                             to exercise the worker-first gate.
 *   test/worker-ok          — a healthy worker. Runs "real" work and returns
 *                             evidence (a file anchor).
 *   test/worker-disabled    — deterministically returns "Model is disabled".
 *   test/worker-disabled-2  — deterministically returns "Model is disabled".
 *
 * Each incoming /v1/chat/completions request is also appended, one JSON object
 * per line, to the trace file given by MOCK_TRACE (or mock-trace.jsonl in the
 * current directory). The trace is the harness's "what the model was asked /
 * what it did" provenance and is used to PROVE no external provider was hit.
 */
import http from "node:http"
import fs from "node:fs"

const traceFile = process.env.MOCK_TRACE ?? "mock-trace.jsonl"
const requestedPort = Number(process.env.FAKE_OPENAI_PORT ?? 0)

function trace(obj) {
  try {
    fs.appendFileSync(traceFile, JSON.stringify(obj) + "\n")
  } catch {
    /* best-effort */
  }
}

function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  return {
    chunk(delta) {
      res.write(`data: ${JSON.stringify(delta)}\n\n`)
    },
    done() {
      res.write("data: [DONE]\n\n")
      res.end()
    },
  }
}

function streamText(res, text) {
  trace({ model: "scripted", event: "emit_text", text })
  const s = sse(res)
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })
  // stream in two pieces so reasoning/streaming paths are exercised
  const half = Math.ceil(text.length / 2)
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { content: text.slice(0, half) }, finish_reason: null }] })
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { content: text.slice(half) }, finish_reason: null }] })
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  s.done()
}

/**
 * Stream a single tool call. The `@ai-sdk/openai-compatible` provider expects
 * the OpenAI chat-completions tool-call delta shape with aggregated arguments.
 */
function streamToolCall(res, name, args) {
  trace({ model: "scripted", event: "emit_tool", tool: name, args })
  const argStr = JSON.stringify(args)
  const s = sse(res)
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] })
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr } }] }, finish_reason: null }] })
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
  s.done()
}

function sendDisabled(res, model) {
  res.writeHead(403, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message: `Model is disabled`, type: "invalid_request_error", code: "model_is_disabled", model } }))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

/** Encoded marker the root prompt uses to trigger the worker-first script. */
const WORKER_FIRST_MARKER = "OMA_E2E_WORKER_FIRST"
/** Text the worker returns so the harness can assert the worker actually ran. */
const WORKER_EVIDENCE = "OMA_E2E_WORKER_EVIDENCE:src/widget.ts:42"
/** Title-generation system prompt prefix (`@ai-sdk` title call). */
const TITLE_PROMPT = "title generator"

function classifyTurn(body) {
  const messages = body?.messages ?? []
  const last = messages[messages.length - 1]
  const lastRole = last?.role
  const lastContent = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")

  const asText = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ")

  // Title generation call (first call OpenCode makes per session).
  if (asText.toLowerCase().includes(TITLE_PROMPT)) return { kind: "title" }

  // A tool result just came back (role "tool" or a function result).
  if (lastRole === "tool" || lastRole === "function") {
    return { kind: "tool_result", content: lastContent }
  }

  if (asText.includes(WORKER_FIRST_MARKER)) return { kind: "worker_first_go" }

  return { kind: "fresh" }
}

function handleRoot(body, res, state) {
  const model = body?.model ?? "root"
  const t = classifyTurn(body)

  if (t.kind === "title") {
    streamText(res, "OMA E2E routing session")
    return
  }

  if (state.step === undefined) state.step = 0

  if (t.kind === "worker_first_go" && state.step === 0) {
    state.step = 1
    streamToolCall(res, "bash", { command: "grep -R OMA_E2E_WORKER_FIRST ." })
    return
  }

  if (t.kind === "tool_result") {
    if (state.step === 1) {
      // The broad bash was blocked by the worker-first gate; now delegate.
      state.step = 2
      streamToolCall(res, "task", {
        description: "e2e worker probe",
        prompt: "Inspect the repo and report where OMA_E2E_WORKER_FIRST is handled.",
        subagent_type: "explore",
        run_in_background: true,
        load_skills: [],
      })
      return
    }
    if (state.step === 2) {
      state.step = 3
      streamText(res, "OMA_E2E_ROOT_DONE")
      return
    }
    // Any further tool result (e.g. background worker completion wake).
    state.step = 3
    streamText(res, "OMA_E2E_ROOT_DONE")
    return
  }

  // Fallback: fresh prompt differs from the scripted marker.
  streamText(res, `root passthrough for ${model}`)
}

function handleWorkerOk(body, res) {
  const asText = (body?.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ")
  if (asText.toLowerCase().includes(TITLE_PROMPT)) {
    streamText(res, "worker session")
    return
  }
  // The worker "does the work" and returns evidence (a concrete anchor).
  streamText(res, `WORKER_DONE ${WORKER_EVIDENCE}`)
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.includes("/health")) {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok")
    return
  }

  if (req.method !== "POST" || !(req.url.includes("/chat/completions") || req.url.includes("/responses"))) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }))
    return
  }

  const raw = await readBody(req)
  let body = {}
  try { body = JSON.parse(raw) } catch { body = {} }

  const model = body?.model ?? "root"
  trace({ model, url: req.url, messages: (body?.messages ?? []).length, tools: Array.isArray(body?.tools) ? body.tools.map((t) => t?.function?.name ?? t?.name) : undefined })

  if (model === "worker-disabled" || model === "worker-disabled-2" || model === "disabled") {
    trace({ model, event: "disabled_error", message: "Model is disabled" })
    sendDisabled(res, model)
    return
  }

  if (model === "worker-ok" || model === "ok") {
    handleWorkerOk(body, res)
    return
  }

  const rootState = stateForModel(model)
  handleRoot(body, res, rootState)
})

// Per-model turn counters (a single root session in a single test run).
const perModelState = new Map()
function stateForModel(model) {
  if (!perModelState.has(model)) perModelState.set(model, {})
  return perModelState.get(model)
}

server.listen(requestedPort, "127.0.0.1", () => {
  const port = server.address().port
  process.stdout.write(`mock-provider listening on ${port}\n`)
  if (process.env.MOCK_PORT_FILE) {
    try { fs.writeFileSync(process.env.MOCK_PORT_FILE, String(port)) } catch { /* ignore */ }
  }
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
