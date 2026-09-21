#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible mock provider for the LIVE acceptance test
 * of POST-EVIDENCE ROOT VERIFICATION. Speaks `@ai-sdk/openai-compatible`.
 *
 * Scripted models (provider "test"):
 *   test/root        — MAIN/root model, scripted multi-turn behavior:
 *                      broad attempt (blocked) -> delegate ONE explore child ->
 *                      consume background_output -> anchored read ->
 *                      exact-symbol grep -> unrelated broad attempt (blocked).
 *   test/worker-ok   — healthy FREE worker that returns evidence anchors.
 *
 * The root parses the real background task id from the task launch result and
 * keeps emitting tool calls until the controlled unrelated-glob check, so the
 * session stays alive through the whole post-evidence lifecycle.
 */
import http from "node:http"
import fs from "node:fs"

const traceFile = process.env.MOCK_TRACE ?? "mock-trace.jsonl"
const requestedPort = Number(process.env.FAKE_OPENAI_PORT ?? 0)

function trace(obj) {
  try { fs.appendFileSync(traceFile, JSON.stringify(obj) + "\n") } catch { /* best-effort */ }
}

function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  return {
    chunk(delta) { res.write(`data: ${JSON.stringify(delta)}\n\n`) },
    done() { res.write("data: [DONE]\n\n"); res.end() },
  }
}

function streamText(res, text) {
  trace({ model: "scripted", event: "emit_text", text })
  const s = sse(res)
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })
  const half = Math.ceil(text.length / 2)
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { content: text.slice(0, half) }, finish_reason: null }] })
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { content: text.slice(half) }, finish_reason: null }] })
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  s.done()
}

function streamToolCall(res, name, args) {
  trace({ model: "scripted", event: "emit_tool", tool: name, args })
  const argStr = JSON.stringify(args)
  const s = sse(res)
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] })
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr } }] }, finish_reason: null }] })
  s.chunk({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
  s.done()
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

const MARKER = "OMA_LIVE_POST_EVIDENCE"
const WORKER_EVIDENCE = "OMA_LIVE_EVIDENCE:packages/foo/src/bar.ts:120-155 symbol:resolveFoo"
const TITLE_PROMPT = "title generator"

function classifyTurn(body) {
  const messages = body?.messages ?? []
  const last = messages[messages.length - 1]
  const lastRole = last?.role
  const lastContent = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")
  const asText = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ")
  if (asText.toLowerCase().includes(TITLE_PROMPT)) return { kind: "title" }
  if (lastRole === "tool" || lastRole === "function") return { kind: "tool_result", content: lastContent }
  if (asText.includes(MARKER)) return { kind: "go" }
  return { kind: "fresh" }
}

function extractTaskID(content) {
  const match = String(content).match(/bg_[a-zA-Z0-9_-]+/)
  return match ? match[0] : "bg_live"
}

function handleRoot(body, res, state) {
  const model = body?.model ?? "root"
  const t = classifyTurn(body)
  if (t.kind === "title") { streamText(res, "OMA live post-evidence session"); return }
  if (state.step === undefined) state.step = 0

  if (t.kind === "go" && state.step === 0) {
    state.step = 1
    streamToolCall(res, "bash", { command: "grep -R OMA_LIVE_POST_EVIDENCE ." })
    return
  }
  if (t.kind === "tool_result") {
    if (state.step === 1) {
      // The broad bash was blocked; now delegate ONE explore child.
      state.step = 2
      streamToolCall(res, "task", {
        description: "live evidence probe",
        prompt: "Inspect the repo and report exactly where OMA_LIVE_POST_EVIDENCE is handled, with exact file:line anchors.",
        subagent_type: "explore",
        run_in_background: true,
        load_skills: [],
      })
      return
    }
    if (state.step === 2) {
      // Background task launched. Block until it completes so the result is
      // consumed as real worker evidence (not a "still running" status).
      state.step = 3
      streamToolCall(res, "background_output", { task_id: extractTaskID(t.content), block: true })
      return
    }
    if (state.step === 3) {
      // Evidence consumed. Exact anchored read of the worker-provided file.
      state.step = 4
      streamToolCall(res, "read", { filePath: "packages/foo/src/bar.ts", offset: 120, limit: 36 })
      return
    }
    if (state.step === 4) {
      // Exact-symbol verification against a worker-provided symbol.
      state.step = 5
      streamToolCall(res, "grep", { pattern: "resolveFoo", path: "packages/foo/src/bar.ts" })
      return
    }
    if (state.step === 5) {
      // Controlled check: clearly unrelated broad search.
      state.step = 6
      streamToolCall(res, "glob", { pattern: "**/unrelated/**/*.ts" })
      return
    }
    state.step = 6
    streamText(res, "OMA_LIVE_ROOT_DONE")
    return
  }
  streamText(res, `root passthrough for ${model}`)
}

function handleWorkerOk(body, res) {
  const asText = (body?.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ")
  if (asText.toLowerCase().includes(TITLE_PROMPT)) { streamText(res, "worker session"); return }
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

  if (model === "worker-ok" || model === "ok") { handleWorkerOk(body, res); return }

  const rootState = stateForModel(model)
  handleRoot(body, res, rootState)
})

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