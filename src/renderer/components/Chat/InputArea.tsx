import React, { useEffect, useRef, useState, KeyboardEvent, ClipboardEvent, DragEvent } from 'react'
import { FileChipRenderer, getFileTypeInfo, parseFileReferences } from './FileChip'

interface ImageAttachment {
  type: 'image'
  dataUrl: string
  name?: string
}

interface InputAreaProps {
  onSend: (message: string) => void
  isLoading: boolean
  onSendWithAttachments?: (text: string, atts: ImageAttachment[]) => void
  onStop?: () => void
  toolbarLeft?: React.ReactNode
  toolbarRight?: React.ReactNode
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENTS = 4
const buildEditableFileReference = (absPath: string): string => `@file:"${absPath}"`

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
  const [focused, setFocused] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)

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

  const dispatch = (text: string, atts: ImageAttachment[]) => {
    if (atts.length > 0 && onSendWithAttachments) {
      onSendWithAttachments(text, atts)
    } else {
      onSend(text)
    }
  }

  const getChildRawLength = (node: ChildNode): number => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
    if (node instanceof HTMLElement && node.dataset.filePath) {
      return buildEditableFileReference(node.dataset.filePath).length
    }
    if (node.nodeName === 'BR') return 1
    return node.textContent?.length ?? 0
  }

  const serializeEditor = (): string => {
    const root = editorRef.current
    if (!root) return value
    return Array.from(root.childNodes)
      .map((child) => {
        if (child.nodeType === Node.TEXT_NODE) return child.textContent ?? ''
        if (child instanceof HTMLElement && child.dataset.filePath) {
          return buildEditableFileReference(child.dataset.filePath)
        }
        if (child.nodeName === 'BR') return '\n'
        return child.textContent ?? ''
      })
      .join('')
  }

  const getSelectionOffsets = () => {
    const root = editorRef.current
    const sel = window.getSelection()
    const end = serializeEditor().length
    if (!root || !sel || sel.rangeCount === 0) return { start: end, end }
    const range = sel.getRangeAt(0)
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return { start: end, end }
    }

    const computeOffset = (node: Node, offset: number) => {
      if (node === root) {
        return Array.from(root.childNodes)
          .slice(0, offset)
          .reduce((sum, child) => sum + getChildRawLength(child), 0)
      }
      let total = 0
      for (const child of Array.from(root.childNodes)) {
        if (child === node) {
          if (child.nodeType === Node.TEXT_NODE) {
            return total + Math.min(offset, child.textContent?.length ?? 0)
          }
          if (child instanceof HTMLElement && child.dataset.filePath) {
            return total + (offset > 0 ? getChildRawLength(child) : 0)
          }
        }
        total += getChildRawLength(child)
      }
      return total
    }

    return {
      start: computeOffset(range.startContainer, range.startOffset),
      end: computeOffset(range.endContainer, range.endOffset),
    }
  }

  const setSelectionOffsets = (start: number, end = start) => {
    const root = editorRef.current
    const sel = window.getSelection()
    if (!root || !sel) return

    const resolvePoint = (targetOffset: number) => {
      let remaining = Math.max(0, targetOffset)
      const children = Array.from(root.childNodes)
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i]
        const len = getChildRawLength(child)
        if (remaining <= len) {
          if (child.nodeType === Node.TEXT_NODE) {
            return { node: child, offset: Math.min(remaining, child.textContent?.length ?? 0) }
          }
          return { node: root, offset: remaining === 0 ? i : i + 1 }
        }
        remaining -= len
      }
      return { node: root, offset: root.childNodes.length }
    }

    const startPoint = resolvePoint(start)
    const endPoint = resolvePoint(end)
    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const renderEditorValue = (rawValue: string) => {
    const root = editorRef.current
    if (!root) return
    const doc = root.ownerDocument
    const fragment = doc.createDocumentFragment()

    const refs = parseFileReferences(rawValue)
    let cursor = 0

    const appendText = (text: string) => {
      if (!text) return
      fragment.appendChild(doc.createTextNode(text))
    }

    const removeChipNode = (chip: HTMLElement) => {
      const chipIndex = Array.from(root.childNodes).indexOf(chip)
      const offsetBefore = Array.from(root.childNodes)
        .slice(0, chipIndex)
        .reduce((sum, child) => sum + getChildRawLength(child), 0)

      const prev = chip.previousSibling
      const next = chip.nextSibling
      root.removeChild(chip)

      if (prev?.nodeType === Node.TEXT_NODE && next?.nodeType === Node.TEXT_NODE) {
        const prevText = prev.textContent ?? ''
        const nextText = next.textContent ?? ''
        const beforeTrimmed = prevText.replace(/[ \t]+$/, '')
        const afterTrimmed = nextText.replace(/^[ \t]+/, '')
        const needsSpacer =
          beforeTrimmed.length > 0 &&
          afterTrimmed.length > 0 &&
          !beforeTrimmed.endsWith('\n') &&
          !afterTrimmed.startsWith('\n')
        prev.textContent = `${beforeTrimmed}${needsSpacer ? ' ' : ''}${afterTrimmed}`
        root.removeChild(next)
      } else if (prev?.nodeType === Node.TEXT_NODE) {
        prev.textContent = (prev.textContent ?? '').replace(/[ \t]+$/, '')
      } else if (next?.nodeType === Node.TEXT_NODE) {
        next.textContent = (next.textContent ?? '').replace(/^[ \t]+/, '')
      }

      const nextValue = serializeEditor()
      setValue(nextValue)
      root.focus()
      setSelectionOffsets(Math.min(offsetBefore, nextValue.length))
    }

    const createChipNode = (path: string) => {
      const filename = path.split('/').pop() ?? path
      const { label, color, textColor } = getFileTypeInfo(filename)
      const chip = doc.createElement('span')
      chip.dataset.filePath = path
      chip.contentEditable = 'false'
      chip.style.display = 'inline-flex'
      chip.style.alignItems = 'center'
      chip.style.gap = '5px'
      chip.style.background = '#f6f8ff'
      chip.style.borderRadius = '999px'
      chip.style.padding = '2px 7px 2px 4px'
      chip.style.fontSize = '12px'
      chip.style.lineHeight = '18px'
      chip.style.color = '#2e3650'
      chip.style.verticalAlign = 'middle'
      chip.style.maxWidth = '260px'
      chip.style.overflow = 'hidden'
      chip.style.userSelect = 'none'
      chip.style.margin = '0 2px'
      chip.style.border = '1px solid rgba(49, 120, 198, 0.18)'

      const badge = doc.createElement('span')
      badge.textContent = label
      badge.style.background = color
      badge.style.color = textColor
      badge.style.borderRadius = '4px'
      badge.style.padding = '0 4px'
      badge.style.fontSize = '10px'
      badge.style.fontWeight = '700'
      badge.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace'
      badge.style.lineHeight = '16px'
      badge.style.flexShrink = '0'
      chip.appendChild(badge)

      const name = doc.createElement('span')
      name.textContent = filename
      name.style.overflow = 'hidden'
      name.style.textOverflow = 'ellipsis'
      name.style.whiteSpace = 'nowrap'
      name.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace'
      name.style.fontSize = '11.5px'
      chip.appendChild(name)

      const removeBtn = doc.createElement('button')
      removeBtn.type = 'button'
      removeBtn.textContent = '×'
      removeBtn.title = '移除'
      removeBtn.style.width = '14px'
      removeBtn.style.height = '14px'
      removeBtn.style.borderRadius = '50%'
      removeBtn.style.border = 'none'
      removeBtn.style.background = 'rgba(49, 120, 198, 0.12)'
      removeBtn.style.color = '#31589a'
      removeBtn.style.cursor = 'pointer'
      removeBtn.style.display = 'flex'
      removeBtn.style.alignItems = 'center'
      removeBtn.style.justifyContent = 'center'
      removeBtn.style.padding = '0'
      removeBtn.style.flexShrink = '0'
      removeBtn.style.fontSize = '10px'
      removeBtn.style.lineHeight = '1'
      removeBtn.style.marginLeft = '1px'
      removeBtn.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        removeChipNode(chip)
      }
      chip.appendChild(removeBtn)

      return chip
    }

    for (const ref of refs) {
      appendText(rawValue.slice(cursor, ref.start))
      fragment.appendChild(createChipNode(ref.path))
      cursor = ref.end
    }
    appendText(rawValue.slice(cursor))
    root.replaceChildren(fragment)
  }

  const applyEditorValue = (nextValue: string, nextCursor: number, nextSelectionEnd = nextCursor) => {
    setValue(nextValue)
    renderEditorValue(nextValue)
    const root = editorRef.current
    if (!root) return
    root.focus()
    setSelectionOffsets(nextCursor, nextSelectionEnd)
  }

  const insertPlainText = (text: string) => {
    const { start, end } = getSelectionOffsets()
    const before = value.slice(0, start)
    const after = value.slice(end)
    const nextValue = `${before}${text}${after}`
    const nextCursor = before.length + text.length
    applyEditorValue(nextValue, nextCursor)
  }

  const insertFileReferences = (paths: string[]) => {
    const validPaths = paths.filter(Boolean)
    if (validPaths.length === 0) return
    const { start, end } = getSelectionOffsets()
    const before = value.slice(0, start)
    const after = value.slice(end)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    const suffix = after && !/^\s/.test(after) ? ' ' : ''
    const inserted = validPaths.map(buildEditableFileReference).join(' ')
    const nextValue = `${before}${prefix}${inserted}${suffix}${after}`
    const nextCursor = (before + prefix + inserted + suffix).length
    applyEditorValue(nextValue, nextCursor)
  }

  const handleSend = () => {
    const trimmed = value.trim()
    const hasAttachments = attachments.length > 0
    if (!trimmed && !hasAttachments) return

    if (isLoading || queue.length > 0) {
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
    applyEditorValue('', 0)
  }

  useEffect(() => {
    if (isLoading || queue.length === 0) return
    const [head, ...rest] = queue
    setQueue(rest)
    dispatch(head.text, head.attachments)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, queue])

  const removeQueued = (id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id))
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
      return
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      insertPlainText('\n')
    }
  }

  const handleEditorInput = () => {
    setValue(serializeEditor())
  }

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!items) {
      if (text) {
        e.preventDefault()
        insertPlainText(text)
      }
      return
    }

    const imageFiles: File[] = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      void addImageFiles(imageFiles)
      return
    }
    if (text) {
      e.preventDefault()
      insertPlainText(text)
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer?.files || [])
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    const otherFilePaths = files
      .filter((f) => !f.type.startsWith('image/'))
      .map((f) => window.electron?.getPathForFile?.(f) ?? '')
      .filter(Boolean)
    if (imageFiles.length > 0 && attachmentsEnabled) void addImageFiles(imageFiles)
    if (otherFilePaths.length > 0) insertFileReferences(otherFilePaths)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    const items = Array.from(e.dataTransfer.items || [])
    const hasNonImageFile = items.some((item) => item.kind === 'file' && !item.type.startsWith('image/'))
    const hasImageFile = items.some((item) => item.kind === 'file' && item.type.startsWith('image/'))
    if (!hasNonImageFile && (!attachmentsEnabled || !hasImageFile)) return
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget === e.target) setIsDragOver(false)
  }

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  const hasInput = value.trim().length > 0 || attachments.length > 0
  const canSend = hasInput
  const isQueueing = isLoading && hasInput

  const placeholderText =
    queue.length > 0
      ? `已排队 ${queue.length} 条，回复结束后依次发送…`
      : attachmentsEnabled
        ? '输入消息... (Enter 发送，可粘贴图片 / 拖拽图片和文件)'
        : '输入消息... (Enter 发送，可拖拽文件)'

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
            const previewContent = `${previewText}${suffix}`
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
                <div
                  title={previewContent}
                  style={{
                    fontSize: 12,
                    color: '#5f4651',
                    lineHeight: 1.4,
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                  }}
                >
                  <FileChipRenderer text={previewContent} />
                </div>
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

        <div style={{ padding: '14px 16px 8px' }}>
          <div style={{ position: 'relative' }}>
            {value.length === 0 && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  color: '#999',
                  pointerEvents: 'none',
                  lineHeight: 1.5,
                  fontSize: 13,
                  fontFamily: 'inherit',
                }}
              >
                {placeholderText}
              </div>
            )}
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              onInput={handleEditorInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{
                width: '100%',
                minHeight: 24,
                maxHeight: 140,
                overflow: 'auto',
                outline: 'none',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowWrap: 'anywhere',
                lineHeight: 1.5,
                fontSize: 13,
                color: '#333',
                fontFamily: 'inherit',
              }}
            />
          </div>
        </div>

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
