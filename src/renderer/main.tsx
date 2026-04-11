import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SessionProvider } from './contexts/SessionContext'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import './styles/globals.css'

// Hash-based routing:
//   #settings  → standalone settings BrowserWindow → SettingsPanel only
//   #floating  → standalone chat BrowserWindow → full App (same as sidebar)
//   (none)     → the Feishu-snapped sidebar → full App
// The standalone chat window needs the same SessionProvider as the sidebar
// so useSession/useAgentChat work identically.
const route = window.location.hash

const root =
  route === '#settings' ? (
    <SettingsPanel />
  ) : (
    <SessionProvider>
      <App />
    </SessionProvider>
  )

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{root}</React.StrictMode>
)
