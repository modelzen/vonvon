import React, { useState, useRef, KeyboardEvent } from 'react'

interface InputAreaProps { onSend: (message: string) => void; isLoading: boolean }

export function InputArea({ onSend, isLoading }: InputAreaProps): React.ReactElement {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const trimmed = value.trim()
    if (!trimmed || isLoading) return
    onSend(trimmed)
    setValue('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 100)}px`
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', gap: 8,
      padding: '10px 14px', borderTop: '1px solid #fce4ec',
      background: 'rgba(255,255,255,0.9)', flexShrink: 0
    }}>
      <textarea ref={textareaRef} value={value} onChange={handleInput} onKeyDown={handleKeyDown}
        placeholder="输入消息... (Enter 发送)" disabled={isLoading} rows={1}
        style={{
          flex: 1, resize: 'none', borderRadius: 16, border: '1px solid #fce4ec',
          padding: '8px 14px', fontSize: 13, color: '#333', outline: 'none',
          background: 'rgba(255,245,249,0.6)', minHeight: 36, maxHeight: 100,
          overflow: 'hidden', lineHeight: 1.4,
          transition: 'border-color 0.2s, box-shadow 0.2s'
        }}
        onFocus={e => { e.target.style.borderColor = '#FF69B4'; e.target.style.boxShadow = '0 0 0 2px rgba(255,105,180,0.12)' }}
        onBlur={e => { e.target.style.borderColor = '#fce4ec'; e.target.style.boxShadow = 'none' }}
      />
      <button onClick={handleSend} disabled={!value.trim() || isLoading}
        style={{
          width: 34, height: 34, borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: (!value.trim() || isLoading) ? '#fce4ec' : 'linear-gradient(135deg, #FF69B4, #FF1493)',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, transition: 'transform 0.15s, opacity 0.2s',
          opacity: (!value.trim() || isLoading) ? 0.4 : 1
        }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
      </button>
    </div>
  )
}
