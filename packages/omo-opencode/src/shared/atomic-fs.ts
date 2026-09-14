import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

/**
 * Write `content` atomically to `filePath`. Uses a same-directory temp file
 * (`${filePath}.tmp-<random>`), fsync's it, renames onto the target, then
 * fsync's the parent directory so the rename is durable across a crash.
 * Missing parent dirs are created recursively. On any failure the temp file
 * is best-effort unlinked; it is NEVER left behind on a successful write.
 */
export function writeAtomicText(filePath: string, content: string): void {
  const parent = dirname(filePath)
  mkdirSync(parent, { recursive: true })

  const suffix = randomHex(12)
  const tempPath = `${filePath}.tmp-${suffix}`

  try {
    writeFileSync(tempPath, content, { encoding: "utf-8" })

    const fd = openSync(tempPath, "r+")
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    renameSync(tempPath, filePath)

    // fsync the parent directory so the rename is durable. On platforms
    // where opening a directory as "r" is not supported this is a best-effort
    // step - we swallow the error so the write still counts as successful.
    try {
      const dirFd = openSync(parent, "r")
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    } catch {
      // best-effort: directory fsync is unavailable on some platforms (win32)
    }
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // best-effort cleanup; original error is what matters
    }
    throw error
  }
}

/**
 * Serialize `data` as pretty-printed JSON and atomically write it. Thin
 * wrapper over writeAtomicText.
 */
export function writeAtomicJson(filePath: string, data: unknown): void {
  writeAtomicText(filePath, JSON.stringify(data, null, 2))
}

/**
 * Best-effort JSON reader. ENOENT, malformed JSON, and non-object payloads
 * (bare number/string/array/null) all return null. Never throws.
 */
export function readJsonTolerant(filePath: string): unknown | null {
  let raw: string
  try {
    raw = readFileSync(filePath, "utf-8")
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  return parsed
}

/**
 * Best-effort sweep of leftover `${prefix}.tmp-*` files in `dir`. Used by
 * store writers to remove tmp files that a previous process crashed before
 * renaming. Returns the number of entries removed; missing directories and
 * per-file failures are absorbed.
 */
export function sweepStaleTemps(dir: string, prefix: string): number {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }

  const needle = `${prefix}.tmp-`
  let removed = 0
  for (const name of entries) {
    if (!name.startsWith(needle)) continue
    try {
      unlinkSync(`${dir}/${name}`)
      removed += 1
    } catch {
      // best-effort - a concurrent writer may have already renamed it
    }
  }
  return removed
}

function randomHex(bytes: number): string {
  // Small local helper; avoids a Node crypto import for hot paths and keeps
  // the module dependency surface minimal.
  const chars = "0123456789abcdef"
  let out = ""
  for (let i = 0; i < bytes * 2; i += 1) {
    out += chars[Math.floor(Math.random() * 16)]
  }
  return out
}
