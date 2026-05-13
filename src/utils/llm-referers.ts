export type LlmAssistant = 'perplexity' | 'openai' | 'anthropic' | 'google' | 'other'

const ALLOWLIST: Array<{ match: string | RegExp; assistant: LlmAssistant }> = [
  { match: 'chat.openai.com', assistant: 'openai' },
  { match: 'chatgpt.com', assistant: 'openai' },
  { match: 'perplexity.ai', assistant: 'perplexity' },
  { match: 'claude.ai', assistant: 'anthropic' },
  { match: 'gemini.google.com', assistant: 'google' },
  { match: 'bard.google.com', assistant: 'google' },
]

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

export function classifyLlmReferer(
  referer: string,
): { host: string; assistant: LlmAssistant } | null {
  let host: string
  try {
    host = normalizeHostname(new URL(referer).hostname)
  } catch {
    return null
  }
  if (!host) return null
  for (const entry of ALLOWLIST) {
    if (typeof entry.match === 'string') {
      if (host === entry.match) return { host, assistant: entry.assistant }
    } else if (entry.match.test(host)) {
      return { host, assistant: entry.assistant }
    }
  }
  return null
}
