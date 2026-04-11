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
  /** Left-aligned content for the sub-toolbar beneath the textarea.
   *  Typically the model picker. */
  toolbarLeft?: React.ReactNode
  /** Right-aligned content for the sub-toolbar. Typically context usage. */
  toolbarRight?: React.ReactNode
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024   // 5 MB per image
const MAX_ATTACHMENTS = 4

export function InputArea({
  onSend,
  isLoading,
  onSendWithAttachments,
  toolbarLeft,
  toolbarRight,
}: InputAreaProps): React.ReactElement {
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

  // Whole input zone is ONE bubble: single pink border, rounded, with the
  // textarea blending seamlessly into a bottom toolbar row that holds the
  // model picker, usage ring, and send button. No inner borders.
  const [focused, setFocused] = useState(false)

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      style={{
        padding: '8px 12px 12px',
        background: isDragOver ? 'rgba(255,228,240,0.95)' : 'transparent',
        flexShrink: 0,
        transition: 'background 0.15s',
      }}
    >
      <div
        style={{
          background: '#fff',
          border: `1px solid ${focused ? '#FF69B4' : '#fce4ec'}`,
          borderRadius: 22,
          boxShadow: focused
            ? '0 0 0 3px rgba(255,105,180,0.12), 0 8px 28px -12px rgba(255,20,147,0.28)'
            : '0 4px 16px -8px rgba(255,20,147,0.18)',
          transition: 'border-color 0.18s, box-shadow 0.18s',
          overflow: 'hidden',
        }}
      >
        {attachments.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              padding: '10px 12px 0',
            }}
          >
            {attachments.map((a, i) => (
              <div
                key={i}
                style={{
                  position: 'relative',
                  width: 40,
                  height: 40,
                  borderRadius: 6,
                  overflow: 'hidden',
                  border: '1px solid #fce4ec',
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
                    justifyContent: 'center',
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea — no own border/bg, blends into the bubble */}
        <div style={{ padding: '14px 16px 8px' }}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={attachmentsEnabled ? '输入消息... (Enter 发送，可粘贴/拖拽图片)' : '输入消息... (Enter 发送)'}
            disabled={isLoading}
            rows={1}
            style={{
              width: '100%',
              resize: 'none',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              padding: 0,
              fontSize: 13,
              color: '#333',
              minHeight: 24,
              maxHeight: 140,
              overflow: 'auto',
              lineHeight: 1.5,
              fontFamily: 'inherit',
              display: 'block',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Bottom row — model picker (left) + usage ring + send button (right),
            all inside the same bubble. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px 12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
            {toolbarLeft}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {toolbarRight}
            <button
              onClick={handleSend}
              disabled={!canSend}
              title="发送"
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                border: 'none',
                cursor: canSend ? 'pointer' : 'not-allowed',
                background: canSend
                  ? 'linear-gradient(135deg, #FF69B4, #FF1493)'
                  : 'linear-gradient(135deg, #FFB3D1, #FF7EB3)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'transform 0.15s, box-shadow 0.2s',
                boxShadow: canSend
                  ? '0 4px 12px -3px rgba(255, 20, 147, 0.45)'
                  : '0 2px 6px -2px rgba(255, 20, 147, 0.2)',
              }}
              onMouseEnter={(e) => { if (canSend) (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.05)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
