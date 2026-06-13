const QUESTION_MARKERS = ["why", "how", "what", "when", "should", "could", "can ", "does", "is there", "are there"];
const DEBUG_SIGNALS = ["error", "bug", "fail", "broken", "issue", "problem", "crash", "exception", "undefined", "null"];
const ARCH_SIGNALS = ["should we", "approach", "pattern", "design", "architecture", "decide", "best way", "implement"];
const ALL_SIGNALS = [...QUESTION_MARKERS, ...DEBUG_SIGNALS, ...ARCH_SIGNALS];

export function isQualifyingPrompt(prompt: string): boolean {
  if (prompt.trim().length < 20) return false;
  const lower = prompt.toLowerCase();
  return ALL_SIGNALS.some(kw => lower.includes(kw));
}
