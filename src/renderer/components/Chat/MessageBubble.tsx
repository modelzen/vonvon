import React from 'react'
import { StreamingText } from './StreamingText'
import { FileChipRenderer } from './FileChip'
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
        maxWidth: '82%', padding: '9px 13px', fontSize: 13, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        ...(isUser ? {
          background: 'linear-gradient(180deg, #ffeff6 0%, #ffe8f1 100%)',
          color: '#915277',
          borderRadius: '999px',
          boxShadow: '0 12px 24px rgba(203, 188, 232, 0.18), inset 0 1px 0 rgba(255,255,255,0.44)'
        } : {
          background: 'rgba(255,255,255,0.78)', color: '#4f474f',
          borderRadius: '18px 18px 18px 6px',
          boxShadow: '0 6px 18px rgba(213, 204, 230, 0.12)'
        })
      }}>
        {message.isStreaming ? (
          <StreamingText content={message.content} isStreaming={message.isStreaming} />
        ) : (
          <FileChipRenderer text={message.content} tone={isUser ? 'user' : 'default'} />
        )}
      </div>
    </div>
  )
}
