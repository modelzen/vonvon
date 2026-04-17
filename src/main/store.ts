import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import {
  DEFAULT_BACKEND_URL,
  isLegacyDefaultBackendUrl,
  sanitizeBackendUrl,
} from '../shared/backendDefaults'

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
  backendUrlMigrationVersion?: number
  // Whitelist of model IDs (hermes provider models) that the chat page
  // is allowed to surface in its model picker. Persisted across restarts
  // so the user's curation survives app relaunches.
  modelWhitelist: string[]
  // Tab bar persistence
  openTabs: string[]
  activeTabId: string | null
  // Auto-title feature
  autoTitleEnabled: boolean
  titleSummaryModel: { model: string; provider: string } | null
  hermesModelCatalog: {
    providers: Array<{
      slug: string
      name: string
      models: string[]
      total_models: number
      is_current: boolean
      source?: string
    }>
    current: string
    current_provider: string
    fetchedAt: number
  } | null
}

export class ChatStore {
  private _store: any = null
  private _initPromise: Promise<void> | null = null
  private static readonly BACKEND_URL_MIGRATION_VERSION = 2

  private migrateBackendUrl(store: any): void {
    const migrationVersion = store.get('backendUrlMigrationVersion') as unknown
    if (migrationVersion === ChatStore.BACKEND_URL_MIGRATION_VERSION) return

    const raw = store.get('backendUrl') as unknown
    const normalized =
      typeof raw === 'string' && raw.trim().length > 0 ? sanitizeBackendUrl(raw) : DEFAULT_BACKEND_URL
    const nextUrl = isLegacyDefaultBackendUrl(normalized) ? DEFAULT_BACKEND_URL : normalized

    if (raw !== nextUrl) {
      store.set('backendUrl', nextUrl)
    }
    store.set('backendUrlMigrationVersion', ChatStore.BACKEND_URL_MIGRATION_VERSION)
  }

  private readBackendUrl(store: any): string {
    const raw = store.get('backendUrl') as unknown
    if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_BACKEND_URL
    return sanitizeBackendUrl(raw)
  }

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
            backendUrl: DEFAULT_BACKEND_URL,
            backendEnabled: true,
            modelWhitelist: [],
            openTabs: [],
            activeTabId: null,
            autoTitleEnabled: true,
            titleSummaryModel: null,
            hermesModelCatalog: null
          }
        })
        this.migrateBackendUrl(this._store)
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
      url: this.readBackendUrl(store),
      enabled: store.get('backendEnabled') as boolean
    }
  }

  async setBackendConfig(config: Partial<{ url: string; enabled: boolean }>): Promise<void> {
    const store = await this.ensureStore()
    if (config.url !== undefined) {
      const nextUrl =
        typeof config.url === 'string' && config.url.trim().length > 0
          ? sanitizeBackendUrl(config.url)
          : DEFAULT_BACKEND_URL
      store.set('backendUrl', nextUrl)
      store.set('backendUrlMigrationVersion', ChatStore.BACKEND_URL_MIGRATION_VERSION)
    }
    if (config.enabled !== undefined) store.set('backendEnabled', config.enabled)
  }

  async getModelWhitelist(): Promise<string[]> {
    const store = await this.ensureStore()
    const raw = store.get('modelWhitelist') as unknown
    return Array.isArray(raw) ? (raw as string[]) : []
  }

  async setModelWhitelist(ids: string[]): Promise<void> {
    const store = await this.ensureStore()
    // Defensive: dedupe and reject non-strings so bad renderer input can't
    // corrupt the persisted config.
    const clean = Array.from(new Set(ids.filter((v) => typeof v === 'string' && v.length > 0)))
    store.set('modelWhitelist', clean)
  }

  async getOpenTabs(): Promise<string[]> {
    const store = await this.ensureStore()
    const raw = store.get('openTabs') as unknown
    return Array.isArray(raw) ? (raw as string[]) : []
  }

  async setOpenTabs(ids: string[]): Promise<void> {
    const store = await this.ensureStore()
    const clean = Array.from(new Set(ids.filter((v) => typeof v === 'string' && v.length > 0)))
    store.set('openTabs', clean)
  }

  async getActiveTabId(): Promise<string | null> {
    const store = await this.ensureStore()
    const val = store.get('activeTabId') as unknown
    return typeof val === 'string' ? val : null
  }

  async setActiveTabId(id: string | null): Promise<void> {
    const store = await this.ensureStore()
    store.set('activeTabId', id)
  }

  async getAutoTitleEnabled(): Promise<boolean> {
    const store = await this.ensureStore()
    const val = store.get('autoTitleEnabled') as unknown
    return typeof val === 'boolean' ? val : true
  }

  async setAutoTitleEnabled(enabled: boolean): Promise<void> {
    const store = await this.ensureStore()
    store.set('autoTitleEnabled', enabled)
  }

  async getTitleSummaryModel(): Promise<{ model: string; provider: string } | null> {
    const store = await this.ensureStore()
    const val = store.get('titleSummaryModel') as unknown
    if (val && typeof val === 'object' && typeof (val as any).model === 'string') {
      return val as { model: string; provider: string }
    }
    return null
  }

  async setTitleSummaryModel(val: { model: string; provider: string } | null): Promise<void> {
    const store = await this.ensureStore()
    store.set('titleSummaryModel', val ?? null)
  }

  async getHermesModelCatalog(): Promise<StoreSchema['hermesModelCatalog']> {
    const store = await this.ensureStore()
    const val = store.get('hermesModelCatalog') as unknown
    if (!val || typeof val !== 'object') return null
    return val as StoreSchema['hermesModelCatalog']
  }

  async setHermesModelCatalog(
    val: Omit<NonNullable<StoreSchema['hermesModelCatalog']>, 'fetchedAt'> | null
  ): Promise<void> {
    const store = await this.ensureStore()
    store.set(
      'hermesModelCatalog',
      val
        ? {
            ...val,
            fetchedAt: Date.now(),
          }
        : null
    )
  }
}

export const chatStore = new ChatStore()
