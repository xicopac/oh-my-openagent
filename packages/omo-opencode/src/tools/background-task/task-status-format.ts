import type { BackgroundTask } from "../../features/background-agent"
import { providerErrorModelLabel } from "../../features/background-agent/provider-error"
import { formatDuration } from "./time-format"
import { truncateText } from "./truncate-text"

function formatProviderErrorSection(task: BackgroundTask): string {
  const error = task.providerError
  if (!error) return ""

  const model = providerErrorModelLabel(error) ?? "unknown"
  const code = error.code ?? error.name ?? "unknown"
  const message = truncateText(error.message.replaceAll("|", "\\|").replace(/\s+/g, " ").trim(), 500)

  return `

## Provider Error

| Field | Value |
|-------|-------|
| Provider | ${model} |
| Code | ${code} |
| Message | ${message} |
| Retryable | ${error.retryable ? "true" : "false"} |
| Quota exhausted | ${error.quotaExhausted ? "true" : "false"} |`
}

export function formatTaskStatus(task: BackgroundTask): string {
  let duration: string
  if (task.status === "pending" && task.queuedAt) {
    duration = formatDuration(task.queuedAt, undefined)
  } else if (task.startedAt) {
    duration = formatDuration(task.startedAt, task.completedAt)
  } else {
    duration = "N/A"
  }

  const promptPreview = truncateText(task.prompt, 500)

  let progressSection = ""
  if (task.progress?.lastTool) {
    progressSection = `\n| Last tool | ${task.progress.lastTool} |`
  }

  let lastMessageSection = ""
  if (task.progress?.lastMessage) {
    const truncated = truncateText(task.progress.lastMessage, 500)
    const messageTime = task.progress.lastMessageAt ? task.progress.lastMessageAt.toISOString() : "N/A"
    lastMessageSection = `

## Last Message (${messageTime})

\`\`\`
${truncated}
\`\`\``
  }

   let statusNote = ""
   if (task.status === "pending") {
     statusNote = `

> **Queued**: Task is waiting for a concurrency slot to become available.`
   } else if (task.status === "running") {
     statusNote = `

> **Note**: No need to wait explicitly - the system will notify you when this task completes.`
   } else if (task.status === "error") {
     statusNote = `

> **Failed**: The task encountered an error. Check the last message for details.`
   } else if (task.status === "interrupt") {
     statusNote = `

> **Interrupted**: The task was interrupted by a prompt error. The session may contain partial results.`
   } else if (task.status === "blocked") {
     const blockedReason = truncateText(task.error ?? "The task was blocked without a terminal reason.", 500)
     statusNote = `

> **BLOCKED**: ${blockedReason}`
   }

  const providerErrorSection = formatProviderErrorSection(task)
  const durationLabel = task.status === "pending" ? "Queued for" : "Duration"

  return `# Task Status

| Field | Value |
|-------|-------|
| Task ID | \`${task.id}\` |
| Description | ${task.description} |
| Agent | ${task.agent} |
| Status | **${task.status}** |
| ${durationLabel} | ${duration} |
| Session ID | \`${task.sessionId}\` |${progressSection}
${statusNote}${providerErrorSection}
## Original Prompt

\`\`\`
${promptPreview}
\`\`\`${lastMessageSection}`
}
