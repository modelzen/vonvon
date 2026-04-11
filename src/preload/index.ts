import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  // Chat — implemented by worker-3 (Stage 3)
  sendMessage: (message: string, model: string) =>
    ipcRenderer.invoke('chat:send', message, model),

  // Generic store
  storeGet: (key: string) => ipcRenderer.invoke('store:get', key),
  storeSet: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  validateApiKey: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke('settings:validateApiKey', { providerId, apiKey }),
  setApiKey: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke('settings:setApiKey', { providerId, apiKey }),
  setDefaultProvider: (providerId: string) =>
    ipcRenderer.invoke('settings:setDefaultProvider', providerId),
  setDefaultModel: (modelId: string) =>
    ipcRenderer.invoke('settings:setDefaultModel', modelId),

  // Providers
  listProviders: () => ipcRenderer.invoke('providers:list'),

  // Backend config
  getBackendConfig: () => ipcRenderer.invoke('backend:config:get'),
  setBackendConfig: (config: Partial<{ url: string; enabled: boolean }>) =>
    ipcRenderer.invoke('backend:config:set', config),

  // Workspace directory picker
  pickWorkspaceDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('workspace:pickDirectory'),

  // Shell utilities (whitelist enforced in renderer before calling)
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:openExternal', url),
  showItemInFolder: (path: string): void => {
    ipcRenderer.invoke('shell:showItemInFolder', path)
  },

  // Kirby — Stage 2
  detachKirby: () => ipcRenderer.send('kirby:detach'),
  // Sidebar ✕: collapse the sidebar but keep the ball docked at Feishu's
  // top-right corner. See src/main/native/kirby.ts for the full state flow.
  closeKirbySidebar: () => ipcRenderer.send('kirby:close-sidebar'),
  getKirbyState: () => ipcRenderer.invoke('kirby:getState'),

  // Settings window — opens a separate BrowserWindow rendering SettingsPanel
  openSettings: (): void => ipcRenderer.send('settings:open'),
  closeSettings: (): void => ipcRenderer.send('settings:close'),

  // Event listeners
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const allowedChannels = [
      'chat:chunk', 'chat:error', 'chat:done',
      'kirby:snap-proximity', 'kirby:snap-complete', 'kirby:detach',
      'kirby:sidebar-show', 'kirby:sidebar-hide'
    ]
    if (allowedChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args))
    }
  },
  off: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, callback as never)
  }
})

declare global {
  interface Window {
    electron: {
      sendMessage(message: string, model: string): Promise<{ content?: string; error?: string }>
      storeGet(key: string): Promise<unknown>
      storeSet(key: string, value: unknown): Promise<void>
      getSettings(): Promise<{
        defaultProvider: string
        defaultModel: string
        apiKeys: Record<string, boolean>
      }>
      validateApiKey(providerId: string, apiKey: string): Promise<{ valid: boolean; error?: string }>
      setApiKey(providerId: string, apiKey: string): Promise<{ success: boolean }>
      setDefaultProvider(providerId: string): Promise<void>
      setDefaultModel(modelId: string): Promise<void>
      listProviders(): Promise<Array<{ provider: string; model: string; configured: boolean }>>
      getBackendConfig(): Promise<{ url: string; enabled: boolean }>
      setBackendConfig(config: Partial<{ url: string; enabled: boolean }>): Promise<void>
      pickWorkspaceDirectory(): Promise<string | null>
      openExternal(url: string): Promise<void>
      showItemInFolder(path: string): void
      detachKirby(): void
      closeKirbySidebar(): void
      getKirbyState(): Promise<
        'floating' | 'snapping' | 'dockedExpanded' | 'dockedCollapsed'
      >
      openSettings(): void
      closeSettings(): void
      on(channel: string, callback: (...args: unknown[]) => void): void
      off(channel: string, callback: (...args: unknown[]) => void): void
    }
  }
}
