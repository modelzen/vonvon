import { Provider } from './base'
import { OpenAIProvider } from './openai'
import { AnthropicProvider } from './anthropic'

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map()

  constructor() {
    this.providers.set('openai', new OpenAIProvider())
    this.providers.set('anthropic', new AnthropicProvider())
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name)
  }

  getAll(): Provider[] {
    return Array.from(this.providers.values())
  }

  getConfigured(): Provider[] {
    return this.getAll().filter((p) => p.isConfigured())
  }

  updateApiKey(providerName: string, apiKey: string): void {
    switch (providerName) {
      case 'openai':
        this.providers.set('openai', new OpenAIProvider(apiKey))
        break
      case 'anthropic':
        this.providers.set('anthropic', new AnthropicProvider(apiKey))
        break
    }
  }

  getAllModels(): Array<{ provider: string; model: string }> {
    return this.getAll().flatMap((p) =>
      p.models.map((model) => ({ provider: p.name, model }))
    )
  }
}

export const registry = new ProviderRegistry()
