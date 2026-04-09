import React from 'react'

export function AboutSection(): React.ReactElement {
  return (
    <div style={{
      border: '1px solid #fce4ec', borderRadius: 12, padding: '14px',
      background: 'rgba(255,255,255,0.7)', textAlign: 'center'
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%', margin: '0 auto 8px',
        background: 'radial-gradient(circle at 35% 35%, #ffb3d9, #FF69B4 60%, #FF1493)'
      }} />
      <p style={{ fontSize: 13, fontWeight: 600, color: '#333' }}>Vonvon</p>
      <p style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>版本 0.1.0</p>
      <p style={{ fontSize: 11, color: '#ccc', marginTop: 2 }}>macOS AI 助手</p>
    </div>
  )
}
