import { BaseProvider, ChatCompletionOptions } from './base'

export class OpenAIProvider extends BaseProvider {
  name = 'openai'
  models = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']

  private apiKey: string | undefined

  constructor(apiKey?: string) {
    super()
    this.apiKey = apiKey
  }

  isConfigured(): boolean {
    return !!this.apiKey
  }

  async chatCompletion(options: ChatCompletionOptions): Promise<string> {
    if (!this.apiKey) throw new Error('OpenAI API key not configured')

    // TODO: implement streaming with openai SDK in Stage 3
    const { OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: this.apiKey })

    let fullContent = ''
    const stream = await client.chat.completions.create({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      stream: true
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ''
      fullContent += delta
      options.onChunk?.({ content: delta, done: false })
    }

    options.onChunk?.({ content: '', done: true })
    return fullContent
  }
}
