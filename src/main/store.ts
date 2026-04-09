import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface AppSettings {
  defaultProvider: string
  defaultModel: string
  apiKeys: Record<string, boolean>
}

interface StoreSchema {
  encryptedKeys: Record<string, string>
  settings: {
    defaultProvider: string
    defaultModel: string
  }
  messages: ChatMessage[]
  backendUrl: string
  backendEnabled: boolean
}

export class ChatStore {
  private _store: any = null
  private _initPromise: Promise<void> | null = null

  private async ensureStore(): Promise<any> {
    if (this._store) return this._store
    if (!this._initPromise) {
      this._initPromise = (async () => {
        const { default: Store } = await import('electron-store')
        this._store = new (Store as any)<StoreSchema>({
          defaults: {
            encryptedKeys: {},
            settings: {
              defaultProvider: 'openai',
              defaultModel: 'gpt-4o'
            },
            messages: [],
            backendUrl: 'http://localhost:8000',
            backendEnabled: false
          }
        })
      })()
    }
    await this._initPromise
    return this._store
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    const store = await this.ensureStore()
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(apiKey)
      store.set(`encryptedKeys.${providerId}`, encrypted.toString('base64'))
    } else {
      store.set(`encryptedKeys.${providerId}`, Buffer.from(apiKey).toString('base64'))
    }
  }

  async getApiKey(providerId: string): Promise<string | null> {
    const store = await this.ensureStore()
    const encoded = store.get(`encryptedKeys.${providerId}`) as string | undefined
    if (!encoded) return null
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      }
      return Buffer.from(encoded, 'base64').toString('utf-8')
    } catch {
      return null
    }
  }

  async getSettings(): Promise<AppSettings> {
    const store = await this.ensureStore()
    const settings = store.get('settings') as StoreSchema['settings']
    const encryptedKeys = store.get('encryptedKeys') as Record<string, string>
    return {
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
      apiKeys: Object.fromEntries(Object.keys(encryptedKeys).map((k) => [k, true]))
    }
  }

  async setDefaultProvider(providerId: string): Promise<void> {
    const store = await this.ensureStore()
    store.set('settings.defaultProvider', providerId)
  }

  async setDefaultModel(modelId: string): Promise<void> {
    const store = await this.ensureStore()
    store.set('settings.defaultModel', modelId)
  }

  async addUserMessage(content: string): Promise<string> {
    const id = randomUUID()
    const store = await this.ensureStore()
    const messages = store.get('messages') as ChatMessage[]
    messages.push({ id, role: 'user', content, timestamp: Date.now() })
    store.set('messages', messages)
    return id
  }

  async addAssistantMessage(content: string): Promise<string> {
    const id = randomUUID()
    const store = await this.ensureStore()
    const messages = store.get('messages') as ChatMessage[]
    messages.push({ id, role: 'assistant', content, timestamp: Date.now() })
    store.set('messages', messages)
    return id
  }

  async appendToMessage(messageId: string, chunk: string): Promise<void> {
    const store = await this.ensureStore()
    const messages = store.get('messages') as ChatMessage[]
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx !== -1) {
      messages[idx].content += chunk
      store.set('messages', messages)
    }
  }

  async getMessages(): Promise<ChatMessage[]> {
    const store = await this.ensureStore()
    return store.get('messages') as ChatMessage[]
  }

  async clearMessages(): Promise<void> {
    const store = await this.ensureStore()
    store.set('messages', [])
  }

  async getBackendConfig(): Promise<{ url: string; enabled: boolean }> {
    const store = await this.ensureStore()
    return {
      url: store.get('backendUrl') as string,
      enabled: store.get('backendEnabled') as boolean
    }
  }

  async setBackendConfig(config: Partial<{ url: string; enabled: boolean }>): Promise<void> {
    const store = await this.ensureStore()
    if (config.url !== undefined) store.set('backendUrl', config.url)
    if (config.enabled !== undefined) store.set('backendEnabled', config.enabled)
  }
}

export const chatStore = new ChatStore()
