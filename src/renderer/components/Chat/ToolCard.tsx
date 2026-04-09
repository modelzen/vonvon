import React, { useEffect, useState } from 'react'

export interface ToolCardProps {
  toolName: string
  status: 'running' | 'completed' | 'failed'
  duration?: number
  preview?: string
}

const TOOL_EMOJIS: Record<string, string> = {
  web_search: '🔍',
  read_file: '📄',
  write_file: '✏️',
  bash: '💻',
  browser: '🌐',
  memory: '🧠',
  default: '🔧'
}

function getEmoji(toolName: string): string {
  for (const [key, emoji] of Object.entries(TOOL_EMOJIS)) {
    if (toolName.toLowerCase().includes(key)) return emoji
  }
  return TOOL_EMOJIS.default
}

export function ToolCard({ toolName, status, duration, preview }: ToolCardProps): React.ReactElement {
  const [dots, setDots] = useState('.')

  useEffect(() => {
    if (status !== 'running') return
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? '.' : d + '.')), 400)
    return () => clearInterval(id)
  }, [status])

  const statusIcon =
    status === 'running' ? (
      <span style={{ color: '#FF69B4', fontWeight: 600 }}>{dots}</span>
    ) : status === 'completed' ? (
      <span style={{ color: '#4caf50', fontWeight: 700 }}>✓</span>
    ) : (
      <span style={{ color: '#f44336', fontWeight: 700 }}>✗</span>
    )

  const durationText =
    status === 'completed' && duration !== undefined
      ? ` ${duration.toFixed(1)}s`
      : ''

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        margin: '2px 0',
        fontSize: 12,
        borderRadius: 8,
        border: '1px solid #fce4ec',
        background: 'rgba(252,228,236,0.4)',
        color: status === 'failed' ? '#f44336' : '#555',
        maxWidth: '100%',
        userSelect: 'none'
      }}
    >
      <span>{getEmoji(toolName)}</span>
      <span style={{ fontFamily: 'monospace', color: '#d81b60' }}>
        {preview || toolName}
      </span>
      {statusIcon}
      {durationText && (
        <span style={{ color: '#aaa', fontSize: 11 }}>{durationText}</span>
      )}
    </div>
  )
}
