import React, { useEffect, useRef } from 'react'
import { MessageBubble } from './MessageBubble'
import type { ChatMessage } from '../../hooks/useChat'

interface MessageListProps { messages: ChatMessage[]; isLoading: boolean }

export function MessageList({ messages, isLoading }: MessageListProps): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  if (messages.length === 0 && !isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', userSelect: 'none' }}>
        {/* Small cute kirby face */}
        <div style={{
          width: 56, height: 56, borderRadius: '50%', position: 'relative',
          background: 'radial-gradient(circle at 35% 35%, #ffb3d9, #FF69B4 60%, #FF1493)',
          boxShadow: '0 4px 12px rgba(255,105,180,0.3)',
          animation: 'float 3s ease-in-out infinite', marginBottom: 12
        }}>
          {/* Eyes */}
          <div style={{ position: 'absolute', top: 19, left: 14, width: 6, height: 7, background: '#1a1a2e', borderRadius: '50%' }} />
          <div style={{ position: 'absolute', top: 19, left: 30, width: 6, height: 7, background: '#1a1a2e', borderRadius: '50%' }} />
          {/* Blush */}
          <div style={{ position: 'absolute', top: 28, left: 8, width: 9, height: 5, background: 'rgba(255,100,150,0.5)', borderRadius: '50%' }} />
          <div style={{ position: 'absolute', top: 28, left: 35, width: 9, height: 5, background: 'rgba(255,100,150,0.5)', borderRadius: '50%' }} />
        </div>
        <p style={{ fontSize: 13, color: '#FF69B4', fontWeight: 500 }}>发送消息开始对话</p>
        <p style={{ fontSize: 11, color: '#FFB6C1', marginTop: 4 }}>我在这里陪着你 ♡</p>
      </div>
    )
  }

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '12px 14px',
        background:
          'linear-gradient(180deg, rgba(252,251,255,0.995), rgba(246,243,251,0.982))'
      }}
    >
      {messages.map(msg => <MessageBubble key={msg.id} message={msg} />)}
      {isLoading && messages[messages.length - 1]?.role === 'user' && (
        <div style={{ display: 'flex', marginBottom: 10 }}>
          <div style={{
            background: 'rgba(255,255,255,0.8)',
            borderRadius: '18px 18px 18px 6px',
            padding: '8px 14px',
            display: 'flex',
            gap: 4,
            boxShadow: '0 6px 18px rgba(213, 204, 230, 0.12)'
          }}>
            {[0, 150, 300].map(delay => (
              <span key={delay} style={{
                width: 5, height: 5, borderRadius: '50%', background: '#FFB6C1', display: 'inline-block',
                animation: `dot-bounce 1.2s ease-in-out infinite`, animationDelay: `${delay}ms`
              }} />
            ))}
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
