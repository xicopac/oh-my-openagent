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
let incidentQuestionIssued = false
let incidentAwaitingBackgroundOutput = false
let incidentAwaitingTaskResult = false
let incidentTaskCalls = 0
const incidentRetrievedWorkers = new Set()
let quotaWakeWorker = null
let quotaAwaitingOutput = false
const incidentTopics = [
  "authentication telemetry parser",
  "storage migration schema",
  "recovery transport nonce",
  "terminal ledger outbox",
  "definitive halt verification",
]

function incidentPrompt(index) {
  const topic = incidentTopics[index - 1] ?? `independent incident shard ${index}`
  return `CHILD_PROBE scenario=incident; independently inspect ${topic} and report the assigned result.`
}

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
  const emptyTerminalReason = "BLOCKED: assistant turn completed with no output"
  const incidentWakeWorkers = isWake
    ? [...input.matchAll(/bg_[A-Za-z0-9]+/g)].map((match) => match[0])
    : []
  const incidentWakeWorker = incidentWakeWorkers.find((workerID) => !incidentRetrievedWorkers.has(workerID))
    ?? incidentWakeWorkers.at(-1)
  append(
    `[worker-matrix] call=${calls} at=${Date.now()} scenario=${scenario} model=${model} title=${isTitle} root=${isRootProbe} child=${isChild} wake=${isWake} wake_blocked=${isWake && input.includes("BLOCKED")} tool_result=${hasToolResult} input_chars=${input.length}\n`,
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
  if (scenario === "provider-quota" && quotaAwaitingOutput && hasToolResult) {
    quotaAwaitingOutput = false
    const retrieved = input.includes("provider quota exhausted")
      && input.includes("Free usage exceeded, subscribe to Go")
    append(`[worker-matrix] terminal_result_retrieved=${retrieved} worker=${quotaWakeWorker}\n`)
    if (retrieved) {
      append(`[worker-matrix] definitive_exit call=${calls}\n`)
      events.sendSse(res, events.textEvents(calls, "ROOT_EXIT_QUOTA_BLOCKED"))
    } else {
      events.sendSse(res, events.textEvents(calls, "ROOT_EXIT_QUOTA_MISSING"))
    }
    return
  }
  if (isWake && scenario === "provider-quota") {
    const wakeWorkers = [...input.matchAll(/bg_[A-Za-z0-9]+/g)].map((match) => match[0])
    const workerID = quotaWakeWorker ?? wakeWorkers.at(-1)
    if (workerID) {
      quotaWakeWorker = workerID
      quotaAwaitingOutput = true
      append(`[worker-matrix] parent_resumed call=${calls} worker=${workerID}\n`)
      events.sendSse(
        res,
        events.toolCallEvents(calls, "background_output", "call_quota_output", {
          task_id: workerID,
          block: false,
          full_session: false,
          include_thinking: false,
          include_tool_results: true,
          message_limit: 20,
        }),
      )
      return
    }
    append(`[worker-matrix] parent_resumed call=${calls} worker=missing\n`)
    events.sendSse(res, events.textEvents(calls, "PARENT_RESUMED"))
    return
  }
  if (isWake && scenario !== "incident") {
    append(`[worker-matrix] parent_resumed call=${calls}\n`)
    events.sendSse(res, events.textEvents(calls, "PARENT_RESUMED"))
    return
  }
  if (isChild) {
    childRequests += 1
    if (scenario === "provider-quota") {
      append(`[worker-matrix] quota_exhausted child_attempt=${childRequests}\n`)
      res
        .writeHead(429, { "content-type": "application/json", "retry-after": "60" })
        .end(JSON.stringify({
          error: {
            message: "Free usage exceeded, subscribe to Go",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        }))
      return
    }
    if (scenario === "normal") {
      events.sendSse(res, events.textEvents(calls, "CHILD_COMPLETED"))
      return
    }
    if (scenario === "cancel") {
      holdResponse(res, `cancel-child-${childRequests}`)
      return
    }
    if ((scenario === "empty" && childRequests === 1) || scenario === "incident") {
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
  if (scenario === "incident") {
    if (incidentAwaitingBackgroundOutput && hasToolResult) {
      incidentAwaitingBackgroundOutput = false
      const retrieved = input.includes(emptyTerminalReason)
      append(`[worker-matrix] terminal_result_retrieved=${retrieved} workers=${incidentRetrievedWorkers.size}\n`)
      incidentTaskCalls += 1
      incidentAwaitingTaskResult = true
      events.sendSse(
        res,
        events.toolCallEvents(calls, "task", `call_incident_child_${incidentTaskCalls}`, {
          description: `worker incident child ${incidentTaskCalls}`,
          prompt: incidentPrompt(incidentTaskCalls),
          category: "quick",
          run_in_background: true,
          load_skills: [],
        }),
      )
      return
    }
    if (incidentAwaitingTaskResult && hasToolResult) {
      incidentAwaitingTaskResult = false
      if (incidentTaskCalls >= 5) {
        const halted = input.toLowerCase().includes("delegation_recovery_halted")
        append(`[worker-matrix] terminal_dispatch_blocked=${halted} call=${calls}\n`)
        if (halted) {
          append(`[worker-matrix] definitive_exit call=${calls}\n`)
          events.sendSse(res, events.textEvents(calls, "ROOT_EXIT_BLOCKED"))
        } else {
          events.sendSse(res, events.textEvents(calls, "ROOT_EXIT_INVALID_NOT_HALTED"))
        }
        return
      }
      events.sendSse(res, events.textEvents(calls, "ROOT_WAITING"))
      return
    }
    if (isWake && incidentWakeWorker && !incidentRetrievedWorkers.has(incidentWakeWorker)) {
      incidentRetrievedWorkers.add(incidentWakeWorker)
      incidentAwaitingBackgroundOutput = true
      append(`[worker-matrix] parent_resumed call=${calls} worker=${incidentWakeWorker}\n`)
      events.sendSse(
        res,
        events.toolCallEvents(calls, "background_output", `call_output_${incidentRetrievedWorkers.size}`, {
          task_id: incidentWakeWorker,
          block: false,
          full_session: false,
          include_thinking: false,
          include_tool_results: true,
          message_limit: 20,
        }),
      )
      return
    }
    if (rootTaskIssued && !incidentQuestionIssued && hasToolResult) {
      incidentQuestionIssued = true
      append(`[worker-matrix] question_issued call=${calls}\n`)
      events.sendSse(
        res,
        events.toolCallEvents(calls, "question", "call_incident_unanswered_question", {
          questions: [
            {
              header: "Worker",
              question: "Wait for a human before handling the failed delegated worker?",
              options: [
                { label: "Wait", description: "Leave the parent waiting for input." },
                { label: "Recover", description: "Continue autonomous recovery." },
              ],
            },
          ],
        }),
      )
      return
    }
    if (!rootTaskIssued) {
      rootTaskIssued = true
      incidentTaskCalls = 1
      events.sendSse(
        res,
        events.toolCallEvents(calls, "task", "call_root_incident_child_1", {
          description: "worker incident child 1",
          prompt: incidentPrompt(1),
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
