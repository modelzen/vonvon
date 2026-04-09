export interface StreamChunk {
  content: string
  done: boolean
}

export interface ChatCompletionOptions {
  model: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  temperature?: number
  maxTokens?: number
  onChunk?: (chunk: StreamChunk) => void
}

export interface Provider {
  name: string
  models: string[]
  isConfigured(): boolean
  chatCompletion(options: ChatCompletionOptions): Promise<string>
}

export abstract class BaseProvider implements Provider {
  abstract name: string
  abstract models: string[]
  abstract isConfigured(): boolean
  abstract chatCompletion(options: ChatCompletionOptions): Promise<string>
}
