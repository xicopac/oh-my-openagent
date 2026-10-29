import { runTmuxCommand } from "../runner"
import { isInsideTmux } from "./environment"

export type KillTmuxSessionDeps = {
	readonly isInsideTmux: () => boolean
	readonly getTmuxPath: () => Promise<string | null | undefined>
	readonly runTmuxCommand: typeof runTmuxCommand
	readonly log: (message: string, data?: unknown) => void
}

// Interactive/host session names are never owned by an agent. Killing one tears
// down the human's live tmux session, so they are off-limits (case-insensitive).
const PROTECTED_SESSION_NAMES = new Set(["opencode", "main"])

function isUnsafeSessionName(sessionName: string): boolean {
	if (sessionName.length === 0) return true
	if (/\s/.test(sessionName) || sessionName.includes(":")) return true
	return PROTECTED_SESSION_NAMES.has(sessionName.toLowerCase())
}

export async function killTmuxSessionIfExists(
	sessionName: string,
	deps: KillTmuxSessionDeps = {
		isInsideTmux,
		getTmuxPath: async () => null,
		runTmuxCommand,
		log: () => undefined,
	},
): Promise<boolean> {
	// Refuse ambiguous/protected targets before touching tmux (non-throwing).
	if (isUnsafeSessionName(sessionName)) {
		deps.log("[killTmuxSessionIfExists] SKIP: unsafe or protected session name", { sessionName })
		return false
	}

	if (!deps.isInsideTmux()) {
		deps.log("[killTmuxSessionIfExists] SKIP: not inside tmux", { sessionName })
		return false
	}

	const tmux = await deps.getTmuxPath()
	if (!tmux) {
		deps.log("[killTmuxSessionIfExists] SKIP: tmux not found", { sessionName })
		return false
	}

	// Exact-match the target ("=" prefix) so a prefix/similar session name is
	// never resolved by tmux's ambiguous target matching.
	const target = `=${sessionName}`

  const hasSessionResult = await deps.runTmuxCommand(tmux, ["has-session", "-t", target])

	if (hasSessionResult.exitCode !== 0) {
		deps.log("[killTmuxSessionIfExists] SKIP: session not found", { sessionName })
		return false
	}

  const killSessionResult = await deps.runTmuxCommand(tmux, ["kill-session", "-t", target])

	if (killSessionResult.exitCode !== 0) {
		deps.log("[killTmuxSessionIfExists] FAILED", {
			sessionName,
			exitCode: killSessionResult.exitCode,
			stderr: killSessionResult.stderr.trim(),
		})
		return false
	}

	deps.log("[killTmuxSessionIfExists] SUCCESS", { sessionName })
	return true
}
