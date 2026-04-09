import React from 'react'
import { useSettings } from '../../hooks/useSettings'
import { useBackend } from '../../hooks/useBackend'
import { ProviderSettings } from './ProviderSettings'
import { ModelSettings } from './ModelSettings'
import { AboutSection } from './AboutSection'
import { BackendSettings } from './BackendSettings'
import { WorkspacePanel } from './WorkspacePanel'
import { HermesModelPanel } from './HermesModelPanel'
import { HermesAuthPanel } from './HermesAuthPanel'
import { McpServerPanel } from './McpServerPanel'
import { SkillsPanel } from './SkillsPanel'

interface SettingsPanelProps { onBack: () => void }

export function SettingsPanel({ onBack }: SettingsPanelProps): React.ReactElement {
  const { settings, loading, validateApiKey, setDefaultProvider, setDefaultModel } = useSettings()
  const { backendEnabled } = useBackend()

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        borderBottom: '1px solid #fce4ec', background: 'rgba(255,255,255,0.92)', flexShrink: 0
      }}>
        <button onClick={onBack} style={{
          border: 'none', background: 'rgba(255,105,180,0.08)', borderRadius: 8,
          width: 28, height: 28, cursor: 'pointer', color: '#FF69B4', fontSize: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>←</button>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#333' }}>设置</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px', minHeight: 0 }}>
        {backendEnabled ? (
          // Hermes mode: show hermes config panels (AC-C1: this branch only when backendEnabled===true)
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <WorkspacePanel />
            <HermesModelPanel />
            <HermesAuthPanel />
            <McpServerPanel />
            <SkillsPanel />
            <BackendSettings />
            <AboutSection />
          </div>
        ) : (
          // Direct mode: existing panels completely unchanged (AC-C1)
          loading || !settings ? (
            <div style={{ textAlign: 'center', color: '#ccc', padding: 40, fontSize: 13 }}>加载中…</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <ProviderSettings apiKeys={settings.apiKeys} onValidate={validateApiKey} />
              <ModelSettings defaultProvider={settings.defaultProvider} defaultModel={settings.defaultModel}
                apiKeys={settings.apiKeys} onSetDefaultModel={setDefaultModel} onSetDefaultProvider={setDefaultProvider} />
              <BackendSettings />
              <AboutSection />
            </div>
          )
        )}
      </div>
    </div>
  )
}
