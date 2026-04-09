import React from 'react'
import { StreamingText } from './StreamingText'
import type { ChatMessage } from '../../hooks/useChat'

interface MessageBubbleProps { message: ChatMessage }

export function MessageBubble({ message }: MessageBubbleProps): React.ReactElement {
  const isUser = message.role === 'user'

  return (
    <div style={{
      display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 10, animation: 'fade-in 0.2s ease-out'
    }}>
      <div style={{
        maxWidth: '82%', padding: '8px 12px', fontSize: 13, lineHeight: 1.6,
        ...(isUser ? {
          background: 'linear-gradient(135deg, #FF69B4, #FF1493)',
          color: '#fff', borderRadius: '16px 16px 4px 16px'
        } : {
          background: 'rgba(255,255,255,0.85)', color: '#333',
          border: '1px solid #fce4ec', borderRadius: '16px 16px 16px 4px',
          boxShadow: '0 1px 3px rgba(255,105,180,0.08)'
        })
      }}>
        <StreamingText content={message.content} isStreaming={message.isStreaming} />
      </div>
    </div>
  )
}
