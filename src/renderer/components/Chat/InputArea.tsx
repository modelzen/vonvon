import React, { useState, useRef, KeyboardEvent, ClipboardEvent, DragEvent } from 'react'

interface ImageAttachment {
  type: 'image'
  dataUrl: string
  name?: string
}

interface InputAreaProps {
  onSend: (message: string) => void
  isLoading: boolean
  onSendWithAttachments?: (text: string, atts: ImageAttachment[]) => void
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024   // 5 MB per image
const MAX_ATTACHMENTS = 4

export function InputArea({ onSend, isLoading, onSendWithAttachments }: InputAreaProps): React.ReactElement {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const attachmentsEnabled = !!onSendWithAttachments

  const readFileAsDataURL = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
      reader.readAsDataURL(file)
    })

  const addImageFiles = async (files: File[]) => {
    if (!attachmentsEnabled) return
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      if (file.size > MAX_IMAGE_BYTES) {
        alert(`图片 "${file.name}" 超过 5MB，已被拒绝`)
        continue
      }
      if (attachments.length >= MAX_ATTACHMENTS) {
        alert(`每条消息最多 ${MAX_ATTACHMENTS} 张图`)
        break
      }
      try {
        const dataUrl = await readFileAsDataURL(file)
        setAttachments((prev) => {
          if (prev.length >= MAX_ATTACHMENTS) return prev
          return [...prev, { type: 'image', dataUrl, name: file.name }]
        })
      } catch {
        // Swallow: single-file read failure shouldn't block the rest.
      }
    }
  }

  const handleSend = () => {
    const trimmed = value.trim()
    const hasAttachments = attachments.length > 0
    if ((!trimmed && !hasAttachments) || isLoading) return
    if (hasAttachments && onSendWithAttachments) {
      onSendWithAttachments(trimmed, attachments)
      setAttachments([])
    } else {
      onSend(trimmed)
    }
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

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled) return
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      void addImageFiles(files)
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!attachmentsEnabled) return
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'))
    if (files.length > 0) void addImageFiles(files)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!attachmentsEnabled) return
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault()
      setIsDragOver(true)
    }
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!attachmentsEnabled) return
    // Only clear when leaving the wrapper itself, not children
    if (e.currentTarget === e.target) setIsDragOver(false)
  }

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  const canSend = !isLoading && (value.trim().length > 0 || attachments.length > 0)

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 14px',
        borderTop: '1px solid #fce4ec',
        background: isDragOver ? 'rgba(255,228,240,0.95)' : 'rgba(255,255,255,0.9)',
        flexShrink: 0,
        transition: 'background 0.15s'
      }}
    >
      {attachments.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {attachments.map((a, i) => (
            <div
              key={i}
              style={{
                position: 'relative',
                width: 40,
                height: 40,
                borderRadius: 6,
                overflow: 'hidden',
                border: '1px solid #fce4ec'
              }}
            >
              <img
                src={a.dataUrl}
                alt={a.name || 'image'}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
              <button
                onClick={() => removeAttachment(i)}
                title="移除"
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -4,
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  border: 'none',
                  cursor: 'pointer',
                  background: '#FF1493',
                  color: '#fff',
                  fontSize: 10,
                  lineHeight: '14px',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={attachmentsEnabled ? "输入消息... (Enter 发送，可粘贴/拖拽图片)" : "输入消息... (Enter 发送)"}
          disabled={isLoading}
          rows={1}
          style={{
            flex: 1,
            resize: 'none',
            borderRadius: 16,
            border: '1px solid #fce4ec',
            padding: '8px 14px',
            fontSize: 13,
            color: '#333',
            outline: 'none',
            background: 'rgba(255,245,249,0.6)',
            minHeight: 36,
            maxHeight: 100,
            overflow: 'hidden',
            lineHeight: 1.4,
            transition: 'border-color 0.2s, box-shadow 0.2s'
          }}
          onFocus={e => { e.target.style.borderColor = '#FF69B4'; e.target.style.boxShadow = '0 0 0 2px rgba(255,105,180,0.12)' }}
          onBlur={e => { e.target.style.borderColor = '#fce4ec'; e.target.style.boxShadow = 'none' }}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          style={{
            width: 34,
            height: 34,
            borderRadius: '50%',
            border: 'none',
            cursor: 'pointer',
            background: !canSend ? '#fce4ec' : 'linear-gradient(135deg, #FF69B4, #FF1493)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'transform 0.15s, opacity 0.2s',
            opacity: !canSend ? 0.4 : 1
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
