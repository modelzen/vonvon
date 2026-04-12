import React from 'react'
import { AboutSection } from './AboutSection'
import { HermesModelPanel } from './HermesModelPanel'
import { HermesAuthPanel } from './HermesAuthPanel'
import { McpServerPanel } from './McpServerPanel'
import { SkillsPanel } from './SkillsPanel'
import { ChatPreferencesPanel } from './ChatPreferencesPanel'
import {
  pageStyle,
  headerStyle,
  headerTitleStyle,
  scrollAreaStyle,
  tokens,
} from './settingsStyles'

/**
 * Standalone settings surface, loaded into a separate BrowserWindow via the
 * `#settings` hash route (see `src/renderer/main.tsx`).
 *
 * The window uses `titleBarStyle: 'hiddenInset'`, which keeps the macOS
 * traffic-light buttons visible in the top-left corner. There is no
 * in-header close button — users close the window via the native red
 * button.
 */
export function SettingsPanel(): React.ReactElement {
  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <span style={headerTitleStyle}>设置</span>
      </div>
      <div style={scrollAreaStyle}>
        <HermesAuthPanel />
        <HermesModelPanel />
        <ChatPreferencesPanel />
        <McpServerPanel />
        <SkillsPanel />
        <AboutSection />
      </div>
    </div>
  )
}
