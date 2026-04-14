import React from 'react'
import { tokens } from './settingsStyles'

export function AboutSection(): React.ReactElement {
  const [version, setVersion] = React.useState('0.1.3')

  React.useEffect(() => {
    void window.electron
      .getAppVersion()
      .then((appVersion) => {
        setVersion(appVersion)
      })
      .catch(() => {
        // Keep the release version fallback when the preload bridge is unavailable.
      })
  }, [])

  return (
    <section
      style={{
        marginTop: 4,
        padding: '20px 16px',
        textAlign: 'center',
        borderRadius: tokens.radiusCard,
        border: `1px solid ${tokens.border}`,
        background: 'rgba(255, 255, 255, 0.7)',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          margin: '0 auto 10px',
          background: `radial-gradient(circle at 35% 35%, #ffb3d9, ${tokens.brand} 60%, ${tokens.brandStrong})`,
          boxShadow: '0 4px 14px -4px rgba(255, 20, 147, 0.4)',
        }}
      />
      <p style={{ fontSize: 13, fontWeight: 600, color: tokens.ink, margin: 0 }}>Vonvon</p>
      <p style={{ fontSize: 11, color: tokens.inkMuted, marginTop: 4 }}>版本 {version}</p>
      <p style={{ fontSize: 11, color: tokens.inkFaint, marginTop: 2 }}>macOS AI 助手</p>
    </section>
  )
}
