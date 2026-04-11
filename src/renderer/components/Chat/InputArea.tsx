import React, { useState, useRef, useEffect, KeyboardEvent, ClipboardEvent, DragEvent } from 'react'

interface ImageAttachment {
  type: 'image'
  dataUrl: string
  name?: string
}

interface InputAreaProps {
  onSend: (message: string) => void
  isLoading: boolean
  onSendWithAttachments?: (text: string, atts: ImageAttachment[]) => void
  /** Abort the in-flight streaming run. When provided, the send button
   *  swaps to a stop icon while `isLoading` is true. */
  onStop?: () => void
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
  onStop,
  toolbarLeft,
  toolbarRight,
}: InputAreaProps): React.ReactElement {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Client-side message queue. The backend (`/api/chat/send`) holds an
  // asyncio.Lock and rejects concurrent runs ("backend busy"), so we can't
  // actually fire several requests in parallel. Instead, every time the user
  // hits Enter while a run is streaming we push onto this FIFO and auto-fire
  // the head item the moment isLoading flips back to false.
  interface QueuedMsg {
    id: string
    text: string
    attachments: ImageAttachment[]
  }
  const [queue, setQueue] = useState<QueuedMsg[]>([])

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

  // Internal dispatch — fires the actual onSend / onSendWithAttachments call.
  // Used by both the immediate path (handleSend when not loading) and the
  // queue-drain effect below.
  const dispatch = (text: string, atts: ImageAttachment[]) => {
    if (atts.length > 0 && onSendWithAttachments) {
      onSendWithAttachments(text, atts)
    } else {
      onSend(text)
    }
  }

  const handleSend = () => {
    const trimmed = value.trim()
    const hasAttachments = attachments.length > 0
    if (!trimmed && !hasAttachments) return

    if (isLoading || queue.length > 0) {
      // Queue the message instead of dropping it. We also enqueue when the
      // queue is non-empty (even if isLoading momentarily flips to false
      // between drains) so we strictly preserve send order.
      setQueue((prev) => [
        ...prev,
        {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text: trimmed,
          attachments: hasAttachments ? attachments : [],
        },
      ])
    } else {
      dispatch(trimmed, hasAttachments ? attachments : [])
    }
    setAttachments([])
    setValue('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  // Drain the queue head once the in-flight run finishes. We only ever
  // dispatch ONE message per isLoading→false transition: dispatching calls
  // back into the parent which sets isLoading=true synchronously, blocking
  // further drains until that next run completes. This keeps strict FIFO
  // semantics even when several messages are queued.
  useEffect(() => {
    if (isLoading || queue.length === 0) return
    const [head, ...rest] = queue
    setQueue(rest)
    dispatch(head.text, head.attachments)
    // dispatch only closes over prop callbacks, which are stable enough
    // here; intentionally excluded from deps to avoid re-firing the queue
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, queue])

  const removeQueued = (id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id))
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

  // Send/queue button enables whenever there's something to dispatch — we
  // intentionally allow clicking while isLoading so the click queues.
  const hasInput = value.trim().length > 0 || attachments.length > 0
  const canSend = hasInput
  const isQueueing = isLoading && hasInput

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
      {queue.length > 0 && (
        // "Half bubble" sitting just above the input bubble: narrower
        // (left/right inset by 14px), only the top corners are rounded,
        // bottom border removed, and a -1px bottom margin so it merges
        // visually into the main input bubble below.
        <div
          style={{
            margin: '0 14px -1px',
            background: '#fff',
            border: '1px solid #fce4ec',
            borderBottom: 'none',
            borderRadius: '14px 14px 0 0',
            fontFamily:
              '"DM Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            overflow: 'hidden',
          }}
        >
          {queue.map((q, idx) => {
            const previewText =
              q.text || (q.attachments.length > 0 ? `[图片 × ${q.attachments.length}]` : '')
            const suffix =
              q.text && q.attachments.length > 0
                ? `  · 图片 × ${q.attachments.length}`
                : ''
            return (
              <div
                key={q.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 12px',
                  borderTop: idx === 0 ? 'none' : '1px solid #fdf0f5',
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="#c4a3b1"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M5 3 v6 a3 3 0 0 0 3 3 h4" />
                </svg>
                <span
                  title={previewText + suffix}
                  style={{
                    fontSize: 12,
                    color: '#5f4651',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    lineHeight: 1.3,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {previewText}
                  {suffix}
                </span>
                <button
                  type="button"
                  onClick={() => removeQueued(q.id)}
                  title="移除"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    border: 'none',
                    background: 'transparent',
                    color: '#c4a3b1',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    padding: 0,
                    transition: 'background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.background = '#fce4ec'
                    el.style.color = '#FF1493'
                  }}
                  onMouseLeave={(e) => {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.background = 'transparent'
                    el.style.color = '#c4a3b1'
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  </svg>
                </button>
              </div>
            )
          })}
        </div>
      )}
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
            placeholder={
              queue.length > 0
                ? `已排队 ${queue.length} 条，回复结束后依次发送…`
                : attachmentsEnabled
                  ? '输入消息... (Enter 发送，可粘贴/拖拽图片)'
                  : '输入消息... (Enter 发送)'
            }
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
            {isLoading && onStop ? (
              // Stop button — abort the in-flight run AND drop any queued
              // messages so the drain effect doesn't immediately fire the
              // next one after the abort flips isLoading back to false.
              <button
                type="button"
                onClick={() => {
                  setQueue([])
                  onStop()
                }}
                title="停止生成"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  border: 'none',
                  cursor: 'pointer',
                  background: '#1f1f1f',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'transform 0.15s, box-shadow 0.2s',
                  boxShadow: '0 4px 12px -3px rgba(0,0,0,0.35)',
                }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.05)'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'
                }}
              >
                {/* Filled square */}
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <rect x="0" y="0" width="10" height="10" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!canSend}
                title={
                  queue.length > 0
                    ? `队列中已有 ${queue.length} 条，将依次发送`
                    : isQueueing
                      ? '排队此条消息'
                      : '发送'
                }
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
                onMouseEnter={(e) => {
                  if (canSend) (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.05)'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
