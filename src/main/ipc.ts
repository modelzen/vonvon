import { ipcMain } from 'electron'
import { chatStore } from './store'
import { registry } from './providers/registry'
import { registerKirbyIpcHandlers } from './native/kirby'

export function registerIpcHandlers(): void {
  // Chat: send message with streaming response
  ipcMain.handle('chat:send', async (event, message: string, model: string) => {
    const { randomUUID } = await import('crypto')
    const messageId = randomUUID()

    const provider = registry.getAll().find((p) => p.models.includes(model))
    if (!provider) return { error: `No provider found for model: ${model}` }
    if (!provider.isConfigured()) return { error: 'Provider not configured. Please set API key in settings.' }

    const stored = await chatStore.getMessages()
    const history = stored.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    await chatStore.addUserMessage(message)

    try {
      let fullContent = ''
      await provider.chatCompletion({
        model,
        messages: [...history, { role: 'user', content: message }],
        onChunk: (chunk) => {
          if (event.sender.isDestroyed()) return
          if (!chunk.done) {
            fullContent += chunk.content
            event.sender.send('chat:chunk', { messageId, chunk: chunk.content })
          } else {
            event.sender.send('chat:done', { messageId })
          }
        }
      })
      await chatStore.addAssistantMessage(fullContent)
      return { messageId }
    } catch (err: any) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('chat:error', { error: err.message })
      }
      return { error: err.message }
    }
  })

  // Providers: list all models with configured status
  ipcMain.handle('providers:list', async () => {
    const configured = new Set(registry.getConfigured().map((p) => p.name))
    return registry.getAllModels().map(({ provider, model }) => ({
      provider,
      model,
      configured: configured.has(provider)
    }))
  })

  // Generic store handlers
  ipcMain.handle('store:get', async (_event, key: string) => {
    if (key === 'settings') return chatStore.getSettings()
    if (key === 'messages') return chatStore.getMessages()
    if (key === 'backendUrl' || key === 'backendEnabled') {
      const cfg = await chatStore.getBackendConfig()
      return key === 'backendUrl' ? cfg.url : cfg.enabled
    }
    return null
  })

  ipcMain.handle('store:set', async (_event, key: string, value: unknown) => {
    if (key === 'messages' && value === null) {
      await chatStore.clearMessages()
    } else if (key === 'backendUrl') {
      await chatStore.setBackendConfig({ url: value as string })
    } else if (key === 'backendEnabled') {
      await chatStore.setBackendConfig({ enabled: value as boolean })
    }
  })

  ipcMain.handle('backend:config:get', async () => {
    return chatStore.getBackendConfig()
  })

  ipcMain.handle('backend:config:set', async (_event, config: Partial<{ url: string; enabled: boolean }>) => {
    await chatStore.setBackendConfig(config)
  })

  // Settings: get current settings (apiKeys as booleans, no raw keys exposed)
  ipcMain.handle('settings:get', async () => {
    return chatStore.getSettings()
  })

  // Settings: validate API key and save if valid
  ipcMain.handle(
    'settings:validateApiKey',
    async (_event, { providerId, apiKey }: { providerId: string; apiKey: string }) => {
      try {
        let valid = false
        if (providerId === 'openai') {
          const { OpenAI } = await import('openai')
          const client = new OpenAI({ apiKey })
          await client.models.list()
          valid = true
        } else if (providerId === 'anthropic') {
          const Anthropic = await import('@anthropic-ai/sdk')
          const client = new Anthropic.default({ apiKey })
          await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }]
          })
          valid = true
        }
        if (valid) {
          await chatStore.setApiKey(providerId, apiKey)
          registry.updateApiKey(providerId, apiKey)
        }
        return { valid }
      } catch (err: any) {
        return { valid: false, error: err.message || 'Validation failed' }
      }
    }
  )

  // Settings: directly set API key (no validation)
  ipcMain.handle(
    'settings:setApiKey',
    async (_event, { providerId, apiKey }: { providerId: string; apiKey: string }) => {
      await chatStore.setApiKey(providerId, apiKey)
      registry.updateApiKey(providerId, apiKey)
      return { success: true }
    }
  )

  // Settings: update default provider
  ipcMain.handle('settings:setDefaultProvider', async (_event, providerId: string) => {
    await chatStore.setDefaultProvider(providerId)
  })

  // Settings: update default model
  ipcMain.handle('settings:setDefaultModel', async (_event, modelId: string) => {
    await chatStore.setDefaultModel(modelId)
  })

  // Kirby/native handlers — Stage 2
  registerKirbyIpcHandlers()
}
