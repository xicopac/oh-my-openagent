import http from "node:http"
import fs from "node:fs"

const repo = process.env.OMO_REPO
if (!repo) throw new Error("OMO_REPO is required")
const events = await import(`${repo}/.agents/skills/opencode-qa/scripts/lib/fake-openai-events.mjs`)
const logFile = process.env.FAKE_LLM_LOG ?? "/tmp/omo-worker-runtime-matrix.log"
const scenario = process.env.OMO_RUNTIME_SCENARIO ?? "normal"
let calls = 0
let childRequests = 0
let rootTaskIssued = false
let cancelIssued = false
let expectSummary = false

function append(line) {
  try {
    fs.appendFileSync(logFile, line)
  } catch {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function holdResponse(res, label) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.write(": held\n\n")
  res.once("close", () => append(`[worker-matrix] held_connection_closed label=${label}\n`))
  append(`[worker-matrix] hold label=${label}\n`)
}

function emptyEvents(callCount) {
  return [
    {
      type: "response.created",
      response: { id: `resp_${callCount}`, created_at: Math.floor(Date.now() / 1000), model: "gpt-fake" },
    },
    {
      type: "response.completed",
      response: { usage: events.completedUsage() },
    },
  ]
}

async function waitForRunningChild(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (childRequests === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return childRequests > 0
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok")
    return
  }
  if (req.method === "POST" && req.url === "/control/expect-summary") {
    expectSummary = true
    append("[worker-matrix] expect_summary=true\n")
    res.writeHead(204).end()
    return
  }
  if (req.method !== "POST" || !req.url?.includes("/responses")) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }))
    return
  }

  calls += 1
  const raw = await readBody(req)
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch {}
  const input = JSON.stringify(body.input ?? body.messages ?? body)
  const model = typeof body.model === "string" ? body.model : "unknown"
  const isTitle = input.includes("Generate a title")
  const isRootProbe = input.includes("AUTONOMOUS_ROOT_PROBE")
  const isChild = input.includes("CHILD_PROBE") && !isRootProbe
  const isWake = input.includes("BACKGROUND TASK") || input.includes("ALL BACKGROUND TASKS")
  const hasToolResult = input.includes("function_call_output") || input.includes("tool_result")
  append(
    `[worker-matrix] call=${calls} scenario=${scenario} model=${model} title=${isTitle} root=${isRootProbe} child=${isChild} wake=${isWake} wake_blocked=${isWake && input.includes("BLOCKED")} tool_result=${hasToolResult}\n`,
  )

  if (isTitle) {
    events.sendSse(res, events.textEvents(calls, `worker matrix ${scenario}`))
    return
  }
  if (expectSummary && !isChild) {
    expectSummary = false
    append(`[worker-matrix] compaction_summary call=${calls}\n`)
    events.sendSse(res, events.textEvents(calls, "COMPACTION_SUMMARY_PRESERVED"))
    return
  }
  if (isWake) {
    append(`[worker-matrix] parent_resumed call=${calls}\n`)
    events.sendSse(res, events.textEvents(calls, "PARENT_RESUMED"))
    return
  }
  if (isChild) {
    childRequests += 1
    if (scenario === "normal") {
      events.sendSse(res, events.textEvents(calls, "CHILD_COMPLETED"))
      return
    }
    if (scenario === "cancel") {
      holdResponse(res, `cancel-child-${childRequests}`)
      return
    }
    if (scenario === "empty" && childRequests === 1) {
      append(`[worker-matrix] empty_response child_attempt=${childRequests}\n`)
      events.sendSse(res, emptyEvents(calls))
      return
    }
    if ((scenario === "stall" || scenario === "compact") && childRequests === 1) {
      holdResponse(res, `stalled-child-${childRequests}`)
      return
    }
    events.sendSse(res, events.textEvents(calls, "CHILD_RECOVERED"))
    return
  }
  if (isRootProbe) {
    if (scenario === "cancel" && hasToolResult && !cancelIssued) {
      const childStarted = await waitForRunningChild()
      append(`[worker-matrix] cancel_child_started=${childStarted}\n`)
      cancelIssued = true
      append(`[worker-matrix] cancel_requested call=${calls}\n`)
      events.sendSse(
        res,
        events.toolCallEvents(calls, "background_cancel", "call_cancel_all_workers", { all: true }),
      )
      return
    }
    if (scenario === "cancel" && cancelIssued && hasToolResult) {
      append(`[worker-matrix] cancellation_confirmed call=${calls}\n`)
      events.sendSse(res, events.textEvents(calls, "CANCELLATION_CONFIRMED"))
      return
    }
    if (!rootTaskIssued) {
      rootTaskIssued = true
      events.sendSse(
        res,
        events.toolCallEvents(calls, "task", `call_root_${scenario}_child`, {
          description: `worker matrix ${scenario} child`,
          prompt: `CHILD_PROBE scenario=${scenario}; complete the assigned work.`,
          category: "quick",
          run_in_background: true,
          load_skills: [],
        }),
      )
      return
    }
    events.sendSse(res, events.textEvents(calls, "ROOT_WAITING"))
    return
  }
  if (hasToolResult) {
    events.sendSse(res, events.textEvents(calls, "ROOT_WAITING"))
    return
  }
  events.sendSse(res, events.textEvents(calls, "DONE"))
})

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  append(`[worker-matrix] listening scenario=${scenario} port=${port}\n`)
  process.stdout.write(`FAKE_PORT=${port}\n`)
})

process.on("SIGTERM", () => server.close(() => process.exit(0)))
process.on("SIGINT", () => server.close(() => process.exit(0)))
