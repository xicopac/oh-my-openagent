import {
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

/**
 * Bounded-storage policy for the governance audit journal. All three bounds are
 * best-effort: pruning is safe to skip, never throws, and targets ONLY the
 * governance journal's own files (never unrelated `~/.omo` data).
 */
export type RetentionPolicy = {
  /** Maximum number of per-session journal directories to retain (oldest dropped first). */
  max_sessions: number
  /** Drop session journals whose mtime is older than this many days. */
  max_age_days: number
  /** Per-file byte bound; when exceeded, the oldest half of the lines is dropped. */
  max_file_bytes: number
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  max_sessions: 100,
  max_age_days: 30,
  max_file_bytes: 5 * 1024 * 1024, // 5 MiB per session journal
}

type SessionDir = { name: string; mtimeMs: number }

function listSessionDirs(root: string): SessionDir[] {
  const entries = readdirSync(root, { withFileTypes: true })
  const dirs: SessionDir[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    try {
      dirs.push({ name: entry.name, mtimeMs: statSync(full).mtimeMs })
    } catch {
      // vanished between readdir and stat; skip
    }
  }
  return dirs
}

/**
 * Best-effort retention sweep over the governance journal root. Enforces, in
 * order:
 *
 *   1. age bound      — remove session dirs last modified before the cutoff
 *   2. count bound    — remove the oldest session dirs past `max_sessions`
 *   3. byte bound     — when a single `events.jsonl` exceeds `max_file_bytes`,
 *                        keep only the newest half of its lines
 *
 * Only directories under `root` are ever touched. Missing roots and per-entry
 * failures are absorbed; the returned count is informational only.
 */
export function pruneGovernanceJournals(
  root: string,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: Date = new Date(),
): number {
  let removed = 0

  let dirs: SessionDir[]
  try {
    dirs = listSessionDirs(root)
  } catch {
    return 0
  }

  // 1. age bound
  const cutoff = now.getTime() - policy.max_age_days * 86_400_000
  const survivors: SessionDir[] = []
  for (const dir of dirs) {
    if (dir.mtimeMs < cutoff) {
      try {
        rmSync(join(root, dir.name), { recursive: true, force: true })
        removed += 1
      } catch {
        // best-effort
      }
    } else {
      survivors.push(dir)
    }
  }

  // 2. count bound (oldest first)
  const excess = survivors.length - policy.max_sessions
  if (excess > 0) {
    const oldestFirst = [...survivors].sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (let i = 0; i < excess; i += 1) {
      try {
        rmSync(join(root, oldestFirst[i].name), { recursive: true, force: true })
        removed += 1
      } catch {
        // best-effort
      }
    }
  }

  // 3. per-file byte bound — re-list (count bound may have removed some)
  let current: SessionDir[]
  try {
    current = listSessionDirs(root)
  } catch {
    return removed
  }
  for (const dir of current) {
    const file = join(root, dir.name, "events.jsonl")
    try {
      if (statSync(file).size <= policy.max_file_bytes) continue
      const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.length > 0)
      if (lines.length <= 1) continue
      const keep = lines.slice(Math.floor(lines.length / 2))
      writeFileSync(file, `${keep.join("\n")}\n`)
    } catch {
      // best-effort
    }
  }

  return removed
}
