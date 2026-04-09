import { BaseProvider, ChatCompletionOptions } from './base'

export class AnthropicProvider extends BaseProvider {
  name = 'anthropic'
  models = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']

  private apiKey: string | undefined

  constructor(apiKey?: string) {
    super()
    this.apiKey = apiKey
  }

  isConfigured(): boolean {
    return !!this.apiKey
  }

  async chatCompletion(options: ChatCompletionOptions): Promise<string> {
    if (!this.apiKey) throw new Error('Anthropic API key not configured')

    // TODO: implement streaming with @anthropic-ai/sdk in Stage 3
    const Anthropic = await import('@anthropic-ai/sdk')
    const client = new Anthropic.default({ apiKey: this.apiKey })

    const systemMsg = options.messages.find((m) => m.role === 'system')?.content
    const messages = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    let fullContent = ''
    const stream = await client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      system: systemMsg,
      messages
    })

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        fullContent += chunk.delta.text
        options.onChunk?.({ content: chunk.delta.text, done: false })
      }
    }

    options.onChunk?.({ content: '', done: true })
    return fullContent
  }
}
