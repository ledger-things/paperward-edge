import { describe, it, expect } from 'vitest'
import { classifyLlmReferer } from '../../../src/utils/llm-referers'

describe('classifyLlmReferer', () => {
  it('chat.openai.com → openai', () => {
    expect(classifyLlmReferer('https://chat.openai.com/')).toEqual({
      host: 'chat.openai.com',
      assistant: 'openai',
    })
  })
  it('chatgpt.com → openai', () => {
    expect(classifyLlmReferer('https://chatgpt.com/c/abc')).toEqual({
      host: 'chatgpt.com',
      assistant: 'openai',
    })
  })
  it('strips www.perplexity.ai → perplexity', () => {
    expect(classifyLlmReferer('https://www.perplexity.ai/')).toEqual({
      host: 'perplexity.ai',
      assistant: 'perplexity',
    })
  })
  it('claude.ai → anthropic', () => {
    expect(classifyLlmReferer('https://claude.ai')).toEqual({
      host: 'claude.ai',
      assistant: 'anthropic',
    })
  })
  it('gemini.google.com → google', () => {
    expect(classifyLlmReferer('https://gemini.google.com/')).toEqual({
      host: 'gemini.google.com',
      assistant: 'google',
    })
  })
  it('bard.google.com → google', () => {
    expect(classifyLlmReferer('https://bard.google.com/x')).toEqual({
      host: 'bard.google.com',
      assistant: 'google',
    })
  })
  it('unknown host → null', () => {
    expect(classifyLlmReferer('https://example.com/')).toBeNull()
  })
  it('malformed URL → null', () => {
    expect(classifyLlmReferer('not-a-url')).toBeNull()
  })
  it('mixed case host → normalized', () => {
    expect(classifyLlmReferer('https://CHAT.OPENAI.COM/')).toEqual({
      host: 'chat.openai.com',
      assistant: 'openai',
    })
  })
})
