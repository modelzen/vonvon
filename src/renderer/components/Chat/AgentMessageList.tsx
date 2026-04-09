import React, { useEffect, useRef } from 'react'
import type { AgentMessage } from '../../hooks/useAgentChat'

interface Props {
  messages: AgentMessage[]
  isLoading: boolean
}

function flattenContent(content: string): string {
  return content.replace(/\s*\n+\s*/g, ' ').trim()
}

function TypingDots(): React.ReactElement {
  // 3 pink dots pulsing in sequence via SVG SMIL (no CSS keyframes file needed).
  return (
    <svg width="28" height="8" viewBox="0 0 28 8" aria-label="loading">
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx={4 + i * 10}
          cy={4}
          r={2.5}
          fill="#FF69B4"
        >
          <animate
            attributeName="opacity"
            values="0.25;1;0.25"
            dur="1.2s"
            begin={`${i * 0.2}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values="2;3;2"
            dur="1.2s"
            begin={`${i * 0.2}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </svg>
  )
}

function renderMessage(msg: AgentMessage, isLoading: boolean): React.ReactElement | null {
  if (msg.role === 'user') {
    return (
      <div
        key={msg.id}
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 8
        }}
      >
        <div
          style={{
            maxWidth: '80%',
            padding: '8px 12px',
            borderRadius: 12,
            fontSize: 13,
            background: 'linear-gradient(135deg, #FF69B4, #FF1493)',
            color: '#fff',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {msg.attachments && msg.attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginBottom: msg.content ? 4 : 0, flexWrap: 'wrap' }}>
              {msg.attachments.map((a, i) => (
                <img
                  key={i}
                  src={a.dataUrl}
                  alt={a.name || 'image'}
                  style={{
                    maxWidth: 120,
                    maxHeight: 120,
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.3)',
                    display: 'block'
                  }}
                />
              ))}
            </div>
          )}
          {msg.content}
        </div>
      </div>
    )
  }

  if (msg.role === 'assistant') {
    const showPlaceholder = !msg.content && isLoading
    return (
      <div
        key={msg.id}
        style={{
          display: 'flex',
          justifyContent: 'flex-start',
          marginBottom: 8
        }}
      >
        <div
          style={{
            maxWidth: '80%',
            padding: '8px 12px',
            borderRadius: 12,
            fontSize: 13,
            background: '#fff',
            color: '#333',
            border: '1px solid #fce4ec',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {showPlaceholder ? <TypingDots /> : msg.content}
        </div>
      </div>
    )
  }

  if (msg.role === 'tool') {
    const statusSuffix =
      msg.toolStatus === 'running' ? ' …' : msg.toolStatus === 'failed' ? ' ✗' : ''
    const statusColor = msg.toolStatus === 'failed' ? '#e53935' : '#888'
    const durationText =
      msg.toolDuration && msg.toolDuration > 0 ? ` · ${msg.toolDuration}s` : ''
    return (
      <div key={msg.id} style={{ marginBottom: 3 }}>
        <div
          style={{
            padding: '3px 2px',
            fontSize: 11,
            color: statusColor,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
          }}
        >
          <span>
            ▸ {msg.toolName || 'tool'}
            {statusSuffix}
          </span>
          {durationText && <span style={{ color: '#bbb' }}>{durationText}</span>}
        </div>
        {msg.toolPreview && msg.toolPreview.trim() && (
          <div
            style={{
              marginLeft: 14,
              fontSize: 10,
              color: '#aaa',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
            }}
          >
            {flattenContent(msg.toolPreview)}
          </div>
        )}
      </div>
    )
  }

  if (msg.role === 'thinking') {
    const flat = flattenContent(msg.content)
    if (!flat) return null
    return (
      <div
        key={msg.id}
        style={{
          padding: '3px 2px',
          fontSize: 11,
          color: '#aaa',
          fontStyle: 'italic',
          marginBottom: 3,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        💭 {flat}
      </div>
    )
  }

  return null
}

export function AgentMessageList({ messages, isLoading }: Props): React.ReactElement {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', minHeight: 0 }}>
      {messages.map((msg) => renderMessage(msg, isLoading))}
      <div ref={endRef} />
    </div>
  )
}
