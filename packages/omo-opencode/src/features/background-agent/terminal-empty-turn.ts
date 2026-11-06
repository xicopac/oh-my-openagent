const TERMINAL_EMPTY_TURN_PREFIX = "BLOCKED: assistant turn ended without output:"
const TERMINAL_EMPTY_TURN_MESSAGE = "BLOCKED: assistant turn completed with no output"

export function formatTerminalEmptyAssistantTurnReason(error?: string): string {
  return error ? `${TERMINAL_EMPTY_TURN_PREFIX} ${error}` : TERMINAL_EMPTY_TURN_MESSAGE
}

export function isTerminalEmptyAssistantTurnReason(reason: string | undefined): boolean {
  return reason === TERMINAL_EMPTY_TURN_MESSAGE
    || reason?.startsWith(TERMINAL_EMPTY_TURN_PREFIX) === true
}
