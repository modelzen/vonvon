import React, { useState } from 'react'
import { useBackend } from '../../hooks/useBackend'

export function BackendSettings(): React.ReactElement {
  const { backendUrl, backendEnabled, isConnected, testConnection, saveConfig } = useBackend()
  const [url, setUrl] = useState(backendUrl)
  const [enabled, setEnabled] = useState(backendEnabled)
  const [testing, setTesting] = useState(false)

  const handleTest = async () => {
    setTesting(true)
    await testConnection(url)
    setTesting(false)
  }

  const handleSave = async () => {
    await saveConfig(url, enabled)
  }

  return (
    <div style={{ padding: '16px 0' }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: '#d81b60', marginBottom: 12 }}>
        后端连接设置
      </h3>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: '#555', display: 'block', marginBottom: 4 }}>
          后端地址
        </label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://localhost:8000"
          style={{
            width: '100%',
            padding: '6px 10px',
            fontSize: 12,
            border: '1px solid #fce4ec',
            borderRadius: 6,
            outline: 'none',
            boxSizing: 'border-box'
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button
          onClick={handleTest}
          disabled={testing}
          style={{
            padding: '5px 14px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid #FF69B4',
            background: '#fff',
            color: '#FF69B4',
            cursor: testing ? 'default' : 'pointer',
            fontWeight: 600,
            opacity: testing ? 0.6 : 1
          }}
        >
          {testing ? '测试中...' : '测试连接'}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: isConnected ? '#4caf50' : '#f44336',
              transition: 'background 0.3s'
            }}
          />
          <span style={{ fontSize: 11, color: '#777' }}>
            {isConnected ? '已连接' : '未连接'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <input
          type="checkbox"
          id="backend-enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <label htmlFor="backend-enabled" style={{ fontSize: 12, color: '#555', cursor: 'pointer' }}>
          启用 Agent 模式（使用 hermes-agent 后端）
        </label>
      </div>

      <button
        onClick={handleSave}
        style={{
          padding: '6px 18px',
          fontSize: 12,
          borderRadius: 6,
          border: 'none',
          background: 'linear-gradient(135deg, #FF69B4, #FF1493)',
          color: '#fff',
          cursor: 'pointer',
          fontWeight: 600
        }}
      >
        保存
      </button>
    </div>
  )
}
