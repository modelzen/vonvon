import React, {
  useEffect,
  useRef,
  useState,
  KeyboardEvent,
  ClipboardEvent,
  DragEvent,
} from 'react'
import {
  FileChipRenderer,
  buildFileReference,
  buildLarkDocReference,
  buildSkillReference,
  getFileTypeInfo,
  parseInlineReferences,
  parseSkillReferences,
} from './FileChip'
import { useHermesConfig, type FeishuLinkPreview, type SkillView } from '../../hooks/useHermesConfig'

interface ImageAttachment {
  type: 'image'
  dataUrl: string
  name?: string
}

interface InputAreaProps {
  onSend: (message: string, skills?: string[]) => void
  isLoading: boolean
  onSendWithAttachments?: (text: string, atts: ImageAttachment[], skills?: string[]) => void
  onStop?: () => void
  placeholderTips?: string[]
  toolbarLeft?: React.ReactNode
  toolbarRight?: React.ReactNode
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENTS = 4
const MAX_SKILL_SUGGESTIONS = 8
const MAX_OTHER_SKILL_SUGGESTIONS = 5
const MAX_LARK_SKILL_PREVIEW = 3
const PLACEHOLDER_TIP_INTERVAL_MS = 4200
const PLACEHOLDER_TIP_FADE_MS = 220
const FEISHU_LINK_RESOLVE_DEBOUNCE_MS = 280
const PLACEHOLDER_TIPS_WITH_ATTACHMENTS = [
  '今天想聊点什么？',
  '输个 /，我来找 skill',
  '贴张图给我看看',
  '把文件拖进来，我接着做',
]
const PLACEHOLDER_TIPS_FILES_ONLY = [
  '今天想聊点什么？',
  '输个 /，我来找 skill',
  '把文件拖进来，我接着做',
]
const FOCUSED_PLACEHOLDER_TEXT = '想让我怎么帮你？试试 /'

const hexToRgba = (hex: string, alpha: number): string => {
  const raw = hex.replace('#', '')
  const full = raw.length === 3 ? raw.split('').map((char) => char + char).join('') : raw
  const value = parseInt(full, 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface SlashState {
  start: number
  end: number
  query: string
}

interface SelectionOffsets {
  start: number
  end: number
}

const TRAILING_BREAK_PLACEHOLDER_ATTR = 'data-trailing-break-placeholder'
const FEISHU_DOC_URL_RE = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?，。；：！？）\]]/g

const FEISHU_DOC_PATH_SEGMENTS = new Set([
  'doc',
  'docs',
  'docx',
  'sheet',
  'sheets',
  'wiki',
  'slides',
  'base',
  'bitable',
])

const isFeishuDocUrl = (raw: string): boolean => {
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase()
    if (
      !host.endsWith('.feishu.cn') &&
      !host.endsWith('.larksuite.com') &&
      host !== 'feishu.cn' &&
      host !== 'larksuite.com'
    ) {
      return false
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    return segments.some((segment) => FEISHU_DOC_PATH_SEGMENTS.has(segment.toLowerCase()))
  } catch {
    return false
  }
}

const skillSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')

const getSkillSourceLabel = (skill: SkillView): string => {
  const source = (skill.source || '').toLowerCase()
  if (source === 'builtin') return 'vonvon'
  if (source === 'official') return '官方'
  if (source === 'community') return '社区'
  if (source === 'local' || source === 'personal') return '个人'
  return skill.source || 'skill'
}

const isOfficialLarkSkill = (skill: SkillView): boolean =>
  skill.name.trim().toLowerCase().startsWith('lark-')

const isLarkFocusedQuery = (query: string): boolean => {
  const lowered = query.trim().toLowerCase()
  return lowered.startsWith('lark') || lowered.includes('飞书') || lowered.includes('feishu')
}

const findSlashState = (text: string, cursor: number): SlashState | null => {
  if (cursor < 0 || cursor > text.length) return null
  const before = text.slice(0, cursor)
  const match = /(^|[\s\n])\/([a-zA-Z0-9-]*)$/.exec(before)
  if (!match) return null
  const query = match[2] ?? ''
  const start = cursor - query.length - 1
  if (start < 0) return null
  return { start, end: cursor, query }
}

const scoreSkillMatch = (skill: SkillView, query: string): number => {
  if (!query) return 100
  const lowered = query.toLowerCase()
  const name = skill.name.toLowerCase()
  const slug = skillSlug(skill.name)
  const desc = (skill.description || '').toLowerCase()
  if (slug === lowered || name === lowered) return 0
  if (slug.startsWith(lowered)) return 1
  if (name.startsWith(lowered)) return 2
  if (slug.includes(lowered)) return 3
  if (name.includes(lowered)) return 4
  if (desc.includes(lowered)) return 5
  return Number.POSITIVE_INFINITY
}

export function InputArea({
  onSend,
  isLoading,
  onSendWithAttachments,
  onStop,
  placeholderTips: extraPlaceholderTips,
  toolbarLeft,
  toolbarRight,
}: InputAreaProps): React.ReactElement {
  const hermesConfig = useHermesConfig()
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [focused, setFocused] = useState(false)
  const [availableSkills, setAvailableSkills] = useState<SkillView[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [slashState, setSlashState] = useState<SlashState | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [larkGroupExpanded, setLarkGroupExpanded] = useState(false)
  const [skillsLoadedOnce, setSkillsLoadedOnce] = useState(false)
  const [placeholderTipIndex, setPlaceholderTipIndex] = useState(0)
  const [placeholderTipLeaving, setPlaceholderTipLeaving] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)
  const larkPreviewCacheRef = useRef<Map<string, FeishuLinkPreview>>(new Map())
  const pendingLarkPreviewUrlsRef = useRef<Set<string>>(new Set())

  interface QueuedMsg {
    id: string
    text: string
    attachments: ImageAttachment[]
  }
  const [queue, setQueue] = useState<QueuedMsg[]>([])

  const attachmentsEnabled = !!onSendWithAttachments

  const refreshSkills = async () => {
    setSkillsLoading(true)
    try {
      const skills = await hermesConfig.listSkills()
      setAvailableSkills(
        skills
          .filter((skill) => skill.enabled)
          .sort((a, b) => a.name.localeCompare(b.name))
      )
      setSkillsLoadedOnce(true)
    } catch {
      setAvailableSkills([])
    } finally {
      setSkillsLoading(false)
    }
  }

  useEffect(() => {
    void refreshSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const collectBareFeishuUrls = (rawValue: string): string[] => {
    const refs = parseInlineReferences(rawValue)
    const urls: string[] = []
    const seen = new Set<string>()
    let match: RegExpExecArray | null
    FEISHU_DOC_URL_RE.lastIndex = 0
    while ((match = FEISHU_DOC_URL_RE.exec(rawValue)) !== null) {
      const url = match[0]
      if (!isFeishuDocUrl(url)) continue
      const index = match.index
      const insideToken = refs.some((ref) => index >= ref.start && index < ref.end)
      if (insideToken || seen.has(url)) continue
      seen.add(url)
      urls.push(url)
    }
    return urls
  }

  const replaceResolvedFeishuUrls = (
    rawValue: string,
    selection: SelectionOffsets,
    previews: Map<string, FeishuLinkPreview>
  ): { nextValue: string; nextStart: number; nextEnd: number } => {
    const refs = parseInlineReferences(rawValue)
    const replacements: Array<{ start: number; end: number; raw: string }> = []
    let segmentCursor = 0

    const collectSegmentReplacements = (segment: string, baseOffset: number) => {
      let match: RegExpExecArray | null
      FEISHU_DOC_URL_RE.lastIndex = 0
      while ((match = FEISHU_DOC_URL_RE.exec(segment)) !== null) {
        const url = match[0]
        const preview = previews.get(url)
        if (!preview || !isFeishuDocUrl(url)) continue
        replacements.push({
          start: baseOffset + match.index,
          end: baseOffset + match.index + url.length,
          raw: buildLarkDocReference(preview.title, preview.url),
        })
      }
    }

    for (const ref of refs) {
      if (ref.start > segmentCursor) {
        collectSegmentReplacements(rawValue.slice(segmentCursor, ref.start), segmentCursor)
      }
      segmentCursor = ref.end
    }
    if (segmentCursor < rawValue.length) {
      collectSegmentReplacements(rawValue.slice(segmentCursor), segmentCursor)
    }

    if (replacements.length === 0) {
      return { nextValue: rawValue, nextStart: selection.start, nextEnd: selection.end }
    }

    replacements.sort((a, b) => a.start - b.start)

    let nextValue = ''
    let cursor = 0
    for (const replacement of replacements) {
      nextValue += rawValue.slice(cursor, replacement.start)
      nextValue += replacement.raw
      cursor = replacement.end
    }
    nextValue += rawValue.slice(cursor)

    const mapOffset = (offset: number): number => {
      let delta = 0
      for (const replacement of replacements) {
        if (offset <= replacement.start) break
        if (offset >= replacement.end) {
          delta += replacement.raw.length - (replacement.end - replacement.start)
          continue
        }
        return replacement.start + delta + replacement.raw.length
      }
      return offset + delta
    }

    return {
      nextValue,
      nextStart: mapOffset(selection.start),
      nextEnd: mapOffset(selection.end),
    }
  }

  const resolveBareFeishuUrls = async () => {
    const rawValue = getCurrentRawValue()
    const urls = collectBareFeishuUrls(rawValue).filter((url) => {
      return (
        !larkPreviewCacheRef.current.has(url) &&
        !pendingLarkPreviewUrlsRef.current.has(url)
      )
    })

    if (urls.length > 0) {
      urls.forEach((url) => pendingLarkPreviewUrlsRef.current.add(url))
      const results = await Promise.all(
        urls.map(async (url) => {
          try {
            const preview = await hermesConfig.previewFeishuLink(url)
            return { url, preview }
          } catch {
            return null
          } finally {
            pendingLarkPreviewUrlsRef.current.delete(url)
          }
        })
      )
      results.forEach((result) => {
        if (!result) return
        larkPreviewCacheRef.current.set(result.url, result.preview)
      })
    }

    const latestRawValue = getCurrentRawValue()
    if (collectBareFeishuUrls(latestRawValue).length === 0) return
    const selection = getSelectionOffsets()
    const { nextValue, nextStart, nextEnd } = replaceResolvedFeishuUrls(
      latestRawValue,
      selection,
      larkPreviewCacheRef.current
    )
    if (nextValue !== latestRawValue) {
      applyEditorValue(nextValue, nextStart, nextEnd, { focusEditor: focused })
    }
  }

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

  const syncSlashState = (rawValue: string, start: number, end = start) => {
    if (start !== end) {
      setSlashState(null)
      setSlashIndex(0)
      return
    }
    const nextSlash = findSlashState(rawValue, start)
    setSlashState(nextSlash)
    if (!nextSlash) setSlashIndex(0)
  }

  const getChildRawLength = (node: ChildNode): number => {
    if (
      node instanceof HTMLElement &&
      node.nodeName === 'BR' &&
      node.hasAttribute(TRAILING_BREAK_PLACEHOLDER_ATTR)
    ) {
      return 0
    }
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
    if (node instanceof HTMLElement && node.dataset.filePath) {
      return buildFileReference(node.dataset.filePath).length
    }
    if (node instanceof HTMLElement && node.dataset.skillName) {
      return buildSkillReference(node.dataset.skillName).length
    }
    if (node instanceof HTMLElement && node.dataset.larkDocTitle && node.dataset.larkDocUrl) {
      return buildLarkDocReference(node.dataset.larkDocTitle, node.dataset.larkDocUrl).length
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
          return buildFileReference(child.dataset.filePath)
        }
        if (child instanceof HTMLElement && child.dataset.skillName) {
          return buildSkillReference(child.dataset.skillName)
        }
        if (child instanceof HTMLElement && child.dataset.larkDocTitle && child.dataset.larkDocUrl) {
          return buildLarkDocReference(child.dataset.larkDocTitle, child.dataset.larkDocUrl)
        }
        if (
          child instanceof HTMLElement &&
          child.nodeName === 'BR' &&
          child.hasAttribute(TRAILING_BREAK_PLACEHOLDER_ATTR)
        ) {
          return ''
        }
        if (child.nodeName === 'BR') return '\n'
        return child.textContent ?? ''
      })
      .join('')
  }

  const getCurrentRawValue = (): string => {
    const root = editorRef.current
    return root ? serializeEditor() : value
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
          if (
            child instanceof HTMLElement &&
            (child.dataset.filePath || child.dataset.skillName || child.dataset.larkDocUrl)
          ) {
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

    const refs = parseInlineReferences(rawValue)
    let cursor = 0

    const appendText = (text: string) => {
      if (!text) return
      const parts = text.split('\n')
      parts.forEach((part, index) => {
        if (part) fragment.appendChild(doc.createTextNode(part))
        if (index < parts.length - 1) {
          fragment.appendChild(doc.createElement('br'))
        }
      })
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
      syncSlashState(nextValue, Math.min(offsetBefore, nextValue.length))
      root.focus()
      setSelectionOffsets(Math.min(offsetBefore, nextValue.length))
    }

    const createFileChipNode = (path: string) => {
      const filename = path.split('/').pop() ?? path
      const { label, accent, titleColor } = getFileTypeInfo(filename)
      const chip = doc.createElement('span')
      chip.dataset.filePath = path
      chip.contentEditable = 'false'
      chip.style.display = 'inline-flex'
      chip.style.alignItems = 'center'
      chip.style.gap = '5px'
      chip.style.background = hexToRgba(accent, 0.09)
      chip.style.borderRadius = '10px'
      chip.style.padding = '0 7px'
      chip.style.fontSize = '11.5px'
      chip.style.lineHeight = '18px'
      chip.style.color = titleColor
      chip.style.verticalAlign = 'middle'
      chip.style.maxWidth = '236px'
      chip.style.overflow = 'hidden'
      chip.style.userSelect = 'none'
      chip.style.margin = '0 2px'
      chip.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.52)'

      const badge = doc.createElement('span')
      badge.textContent = label.toLowerCase()
      badge.style.color = accent
      badge.style.fontSize = '10px'
      badge.style.fontWeight = '700'
      badge.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace'
      badge.style.lineHeight = '16px'
      badge.style.flexShrink = '0'
      badge.style.letterSpacing = '-0.08px'
      badge.style.textTransform = 'lowercase'
      chip.appendChild(badge)

      const name = doc.createElement('span')
      name.textContent = filename
      name.style.overflow = 'hidden'
      name.style.textOverflow = 'ellipsis'
      name.style.whiteSpace = 'nowrap'
      name.style.fontSize = '11.5px'
      name.style.fontWeight = '650'
      name.style.letterSpacing = '-0.1px'
      name.style.color = titleColor
      chip.appendChild(name)

      const removeBtn = doc.createElement('button')
      removeBtn.type = 'button'
      removeBtn.textContent = '×'
      removeBtn.title = '移除'
      removeBtn.style.width = '11px'
      removeBtn.style.height = '11px'
      removeBtn.style.borderRadius = '0'
      removeBtn.style.border = 'none'
      removeBtn.style.background = 'transparent'
      removeBtn.style.color = accent
      removeBtn.style.cursor = 'pointer'
      removeBtn.style.display = 'flex'
      removeBtn.style.alignItems = 'center'
      removeBtn.style.justifyContent = 'center'
      removeBtn.style.padding = '0'
      removeBtn.style.flexShrink = '0'
      removeBtn.style.fontSize = '11px'
      removeBtn.style.lineHeight = '1'
      removeBtn.style.marginLeft = '1px'
      removeBtn.style.opacity = '0.72'
      removeBtn.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        removeChipNode(chip)
      }
      chip.appendChild(removeBtn)

      return chip
    }

    const createSkillChipNode = (name: string) => {
      const accent = '#CF4580'
      const titleColor = '#B63C74'
      const chip = doc.createElement('span')
      chip.dataset.skillName = name
      chip.contentEditable = 'false'
      chip.style.display = 'inline-flex'
      chip.style.alignItems = 'center'
      chip.style.gap = '5px'
      chip.style.background = hexToRgba(accent, 0.09)
      chip.style.borderRadius = '10px'
      chip.style.padding = '0 7px'
      chip.style.fontSize = '11.5px'
      chip.style.lineHeight = '18px'
      chip.style.color = titleColor
      chip.style.verticalAlign = 'middle'
      chip.style.maxWidth = '220px'
      chip.style.overflow = 'hidden'
      chip.style.userSelect = 'none'
      chip.style.margin = '0 2px'
      chip.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.52)'

      const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('width', '12')
      icon.setAttribute('height', '12')
      icon.setAttribute('viewBox', '0 0 24 24')
      icon.setAttribute('fill', 'none')
      icon.setAttribute('stroke', accent)
      icon.setAttribute('stroke-width', '1.65')
      icon.setAttribute('stroke-linecap', 'round')
      icon.setAttribute('stroke-linejoin', 'round')
      icon.setAttribute('aria-hidden', 'true')
      icon.style.flexShrink = '0'

      const iconPath1 = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      iconPath1.setAttribute('d', 'M12 3 5.5 6.75v10.5L12 21l6.5-3.75V6.75L12 3Z')
      const iconPath2 = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      iconPath2.setAttribute('d', 'M12 3v7.5m0 0 6.5-3.75M12 10.5 5.5 6.75')
      icon.appendChild(iconPath1)
      icon.appendChild(iconPath2)
      chip.appendChild(icon)

      const label = doc.createElement('span')
      label.textContent = name
      label.style.overflow = 'hidden'
      label.style.textOverflow = 'ellipsis'
      label.style.whiteSpace = 'nowrap'
      label.style.minWidth = '0'
      label.style.fontWeight = '650'
      label.style.letterSpacing = '-0.1px'
      label.style.color = titleColor
      chip.appendChild(label)

      const removeBtn = doc.createElement('button')
      removeBtn.type = 'button'
      removeBtn.textContent = '×'
      removeBtn.title = '移除'
      removeBtn.style.width = '11px'
      removeBtn.style.height = '11px'
      removeBtn.style.borderRadius = '0'
      removeBtn.style.border = 'none'
      removeBtn.style.background = 'transparent'
      removeBtn.style.color = accent
      removeBtn.style.cursor = 'pointer'
      removeBtn.style.display = 'flex'
      removeBtn.style.alignItems = 'center'
      removeBtn.style.justifyContent = 'center'
      removeBtn.style.padding = '0'
      removeBtn.style.flexShrink = '0'
      removeBtn.style.fontSize = '11px'
      removeBtn.style.lineHeight = '1'
      removeBtn.style.opacity = '0.72'
      removeBtn.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        removeChipNode(chip)
      }
      chip.appendChild(removeBtn)

      return chip
    }

    const createLarkDocChipNode = (title: string, url: string) => {
      const accent = '#2B78E4'
      const titleColor = '#235FB5'
      const chip = doc.createElement('span')
      chip.dataset.larkDocTitle = title
      chip.dataset.larkDocUrl = url
      chip.contentEditable = 'false'
      chip.style.display = 'inline-flex'
      chip.style.alignItems = 'center'
      chip.style.gap = '5px'
      chip.style.background = hexToRgba(accent, 0.1)
      chip.style.borderRadius = '10px'
      chip.style.padding = '0 7px'
      chip.style.fontSize = '11.5px'
      chip.style.lineHeight = '18px'
      chip.style.color = titleColor
      chip.style.verticalAlign = 'middle'
      chip.style.maxWidth = '252px'
      chip.style.overflow = 'hidden'
      chip.style.userSelect = 'none'
      chip.style.margin = '0 2px'
      chip.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.52)'

      const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('width', '12')
      icon.setAttribute('height', '12')
      icon.setAttribute('viewBox', '0 0 24 24')
      icon.setAttribute('fill', 'none')
      icon.setAttribute('stroke', accent)
      icon.setAttribute('stroke-width', '1.7')
      icon.setAttribute('stroke-linecap', 'round')
      icon.setAttribute('stroke-linejoin', 'round')
      icon.setAttribute('aria-hidden', 'true')
      icon.style.flexShrink = '0'

      const iconPath1 = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      iconPath1.setAttribute('d', 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z')
      const iconPath2 = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      iconPath2.setAttribute('d', 'M14 3v5h5')
      const iconPath3 = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      iconPath3.setAttribute('d', 'M9 13h6')
      const iconPath4 = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      iconPath4.setAttribute('d', 'M9 17h4')
      icon.appendChild(iconPath1)
      icon.appendChild(iconPath2)
      icon.appendChild(iconPath3)
      icon.appendChild(iconPath4)
      chip.appendChild(icon)

      const label = doc.createElement('span')
      label.textContent = title
      label.style.overflow = 'hidden'
      label.style.textOverflow = 'ellipsis'
      label.style.whiteSpace = 'nowrap'
      label.style.minWidth = '0'
      label.style.fontWeight = '650'
      label.style.letterSpacing = '-0.1px'
      label.style.color = titleColor
      chip.appendChild(label)

      const removeBtn = doc.createElement('button')
      removeBtn.type = 'button'
      removeBtn.textContent = '×'
      removeBtn.title = '移除'
      removeBtn.style.width = '11px'
      removeBtn.style.height = '11px'
      removeBtn.style.borderRadius = '0'
      removeBtn.style.border = 'none'
      removeBtn.style.background = 'transparent'
      removeBtn.style.color = accent
      removeBtn.style.cursor = 'pointer'
      removeBtn.style.display = 'flex'
      removeBtn.style.alignItems = 'center'
      removeBtn.style.justifyContent = 'center'
      removeBtn.style.padding = '0'
      removeBtn.style.flexShrink = '0'
      removeBtn.style.fontSize = '11px'
      removeBtn.style.lineHeight = '1'
      removeBtn.style.opacity = '0.72'
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
      if (ref.kind === 'file') {
        fragment.appendChild(createFileChipNode(ref.path))
      } else if (ref.kind === 'skill') {
        fragment.appendChild(createSkillChipNode(ref.name))
      } else {
        fragment.appendChild(createLarkDocChipNode(ref.title, ref.url))
      }
      cursor = ref.end
    }
    appendText(rawValue.slice(cursor))
    if (rawValue.endsWith('\n')) {
      const trailingPlaceholder = doc.createElement('br')
      trailingPlaceholder.setAttribute(TRAILING_BREAK_PLACEHOLDER_ATTR, 'true')
      fragment.appendChild(trailingPlaceholder)
    }
    root.replaceChildren(fragment)
  }

  const applyEditorValue = (
    nextValue: string,
    nextCursor: number,
    nextSelectionEnd = nextCursor,
    options?: { focusEditor?: boolean }
  ) => {
    setValue(nextValue)
    renderEditorValue(nextValue)
    syncSlashState(nextValue, nextCursor, nextSelectionEnd)
    const root = editorRef.current
    if (!root) return
    if (options?.focusEditor ?? true) {
      root.focus()
      setSelectionOffsets(nextCursor, nextSelectionEnd)
    }
  }

  const insertPlainText = (text: string) => {
    const currentValue = getCurrentRawValue()
    const { start, end } = getSelectionOffsets()
    const before = currentValue.slice(0, start)
    const after = currentValue.slice(end)
    const nextValue = `${before}${text}${after}`
    const nextCursor = before.length + text.length
    applyEditorValue(nextValue, nextCursor)
  }

  const insertFileReferences = (paths: string[]) => {
    const validPaths = paths.filter(Boolean)
    if (validPaths.length === 0) return
    const currentValue = getCurrentRawValue()
    const { start, end } = getSelectionOffsets()
    const before = currentValue.slice(0, start)
    const after = currentValue.slice(end)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    const suffix = after && !/^\s/.test(after) ? ' ' : ''
    const inserted = validPaths.map(buildFileReference).join(' ')
    const nextValue = `${before}${prefix}${inserted}${suffix}${after}`
    const nextCursor = (before + prefix + inserted + suffix).length
    applyEditorValue(nextValue, nextCursor)
  }

  const insertSkillReference = (skill: SkillView) => {
    const currentValue = getCurrentRawValue()
    const { start, end } = getSelectionOffsets()
    const activeSlash = slashState ?? findSlashState(currentValue, start)
    const replaceStart = activeSlash?.start ?? start
    const replaceEnd = activeSlash?.end ?? end
    const before = currentValue.slice(0, replaceStart)
    const after = currentValue.slice(replaceEnd)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    const suffix = after && !/^\s/.test(after) ? ' ' : ''
    const inserted = buildSkillReference(skill.name)
    const nextValue = `${before}${prefix}${inserted}${suffix}${after}`
    const nextCursor = (before + prefix + inserted + suffix).length
    applyEditorValue(nextValue, nextCursor)
  }

  const inlineSkillNames = new Set(
    parseSkillReferences(value).map((skill) => skill.name.trim().toLowerCase())
  )

  const rankedSlashSuggestions = (slashState ? availableSkills : [])
    .filter((skill) => !inlineSkillNames.has(skill.name.trim().toLowerCase()))
    .map((skill) => ({
      skill,
      score: scoreSkillMatch(skill, slashState?.query ?? ''),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.skill.name.localeCompare(b.skill.name)
    })

  const larkQuery = isLarkFocusedQuery(slashState?.query ?? '')
  const larkSuggestions = rankedSlashSuggestions.filter(({ skill }) => isOfficialLarkSkill(skill))
  const otherSuggestions = rankedSlashSuggestions.filter(({ skill }) => !isOfficialLarkSkill(skill))
  const shouldFullyShowLarkSuggestions = larkQuery || larkGroupExpanded
  const visibleOtherSuggestions = otherSuggestions.slice(
    0,
    shouldFullyShowLarkSuggestions ? 3 : MAX_OTHER_SKILL_SUGGESTIONS
  )
  const visibleLarkSuggestions = larkSuggestions.slice(
    0,
    shouldFullyShowLarkSuggestions
      ? larkSuggestions.length
      : Math.min(
          MAX_LARK_SKILL_PREVIEW,
          Math.max(0, MAX_SKILL_SUGGESTIONS - visibleOtherSuggestions.length)
        )
  )
  const slashSuggestions = [...visibleOtherSuggestions, ...visibleLarkSuggestions]
  const hiddenLarkSkillCount = Math.max(0, larkSuggestions.length - visibleLarkSuggestions.length)

  useEffect(() => {
    if (slashSuggestions.length === 0) {
      setSlashIndex(0)
      return
    }
    setSlashIndex((prev) => Math.min(prev, slashSuggestions.length - 1))
  }, [slashSuggestions.length])

  useEffect(() => {
    if (!slashState) {
      setLarkGroupExpanded(false)
      return
    }
    if (isLarkFocusedQuery(slashState.query)) {
      setLarkGroupExpanded(true)
    }
  }, [slashState])

  useEffect(() => {
    if (!slashState) return
    if (!skillsLoadedOnce || availableSkills.length === 0) {
      void refreshSkills()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashState, skillsLoadedOnce, availableSkills.length])

  const renderSkillSuggestion = (
    skill: SkillView,
    index: number,
    options?: {
      inset?: number
    }
  ): React.ReactElement => {
    const inset = options?.inset ?? 0
    const active = index === slashIndex
    return (
      <button
        key={skill.name}
        type="button"
        onMouseEnter={() => setSlashIndex(index)}
        onMouseDown={(e) => {
          e.preventDefault()
          insertSkillReference(skill)
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          border: 'none',
          background: active ? '#F6F5F7' : 'transparent',
          borderRadius: 16,
          padding: '10px 12px',
          paddingLeft: 12 + inset,
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 0.15s ease, color 0.15s ease',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke={active ? '#202127' : '#6C6C73'}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <path d="M12 3 5.5 6.75v10.5L12 21l6.5-3.75V6.75L12 3Z" />
          <path d="M12 3v7.5m0 0 6.5-3.75M12 10.5 5.5 6.75" />
        </svg>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: active ? '#202127' : '#35353A',
              marginBottom: 2,
            }}
          >
            {skill.name}
          </div>
          <div
            style={{
              fontSize: 12,
              color: '#9A98A1',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {skill.description || '已安装 skill'}
          </div>
        </div>
        <div
          style={{
            flexShrink: 0,
            fontSize: 12,
            color: '#A1A1AA',
          }}
        >
          {getSkillSourceLabel(skill)}
        </div>
      </button>
    )
  }

  const handleSend = () => {
    const rawValue = getCurrentRawValue()
    const trimmed = rawValue.trim()
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
    if (slashState) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (slashSuggestions.length > 0) {
          setSlashIndex((prev) => (prev + 1) % slashSuggestions.length)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (slashSuggestions.length > 0) {
          setSlashIndex((prev) => (prev - 1 + slashSuggestions.length) % slashSuggestions.length)
        }
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (slashSuggestions.length === 0) return
        e.preventDefault()
        insertSkillReference(slashSuggestions[slashIndex]?.skill ?? slashSuggestions[0].skill)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashState(null)
        setSlashIndex(0)
        return
      }
    }

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
    const nextValue = serializeEditor()
    setValue(nextValue)
    const { start, end } = getSelectionOffsets()
    syncSlashState(nextValue, start, end)
  }

  const handleSelectionChange = () => {
    const nextValue = serializeEditor()
    const { start, end } = getSelectionOffsets()
    syncSlashState(nextValue, start, end)
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
  const showSlashMenu = focused && slashState !== null
  const basePlaceholderTips = attachmentsEnabled
    ? PLACEHOLDER_TIPS_WITH_ATTACHMENTS
    : PLACEHOLDER_TIPS_FILES_ONLY
  const placeholderTips = [
    ...(extraPlaceholderTips ?? []),
    ...basePlaceholderTips,
  ]

  useEffect(() => {
    if (value.length === 0) return
    if (collectBareFeishuUrls(value).length === 0) return
    const timeoutId = window.setTimeout(() => {
      void resolveBareFeishuUrls()
    }, FEISHU_LINK_RESOLVE_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timeoutId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused])

  useEffect(() => {
    if (focused) {
      setPlaceholderTipLeaving(false)
      return
    }
    setPlaceholderTipIndex(0)
    setPlaceholderTipLeaving(false)
  }, [focused, attachmentsEnabled, extraPlaceholderTips?.length])

  useEffect(() => {
    if (focused || value.length > 0 || queue.length > 0 || placeholderTips.length <= 1) {
      setPlaceholderTipLeaving(false)
      return
    }

    let timeoutId: number | undefined
    const intervalId = window.setInterval(() => {
      setPlaceholderTipLeaving(true)
      timeoutId = window.setTimeout(() => {
        setPlaceholderTipIndex((prev) => (prev + 1) % placeholderTips.length)
        setPlaceholderTipLeaving(false)
      }, PLACEHOLDER_TIP_FADE_MS)
    }, PLACEHOLDER_TIP_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [focused, placeholderTips.length, queue.length, value.length])

  const placeholderText =
    queue.length > 0
      ? `已排队 ${queue.length} 条，回复结束后依次发送…`
      : focused
        ? FOCUSED_PLACEHOLDER_TEXT
        : placeholderTips[placeholderTipIndex] ?? '输入消息...'

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
        position: 'relative',
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

      {showSlashMenu && (
        <div
          style={{
            margin: queue.length > 0 ? '0 14px 8px' : '0 14px 8px',
            border: '1px solid #f2e6ec',
            borderRadius: 22,
            background: 'rgba(255,255,255,0.98)',
            boxShadow: '0 18px 40px -28px rgba(42, 16, 29, 0.35)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 'min(420px, 46vh)',
          }}
        >
          <div
            style={{
              padding: '12px 16px 8px',
              fontSize: 12,
              fontWeight: 600,
              color: '#8E6C79',
              letterSpacing: '0.02em',
              flexShrink: 0,
            }}
          >
            技能
          </div>
          {skillsLoading ? (
            <div style={{ padding: '0 16px 16px', fontSize: 12, color: '#A1A1AA' }}>加载中…</div>
          ) : slashSuggestions.length > 0 ? (
            <div
              style={{
                padding: '0 8px 8px',
                overflowY: 'auto',
                minHeight: 0,
                overscrollBehavior: 'contain',
              }}
            >
              {visibleOtherSuggestions.map(({ skill }, index) =>
                renderSkillSuggestion(skill, index)
              )}

              {larkSuggestions.length > 0 && (
                <div
                  style={{
                    margin: visibleOtherSuggestions.length > 0 ? '8px 4px 4px' : '0 4px 4px',
                    padding: '8px 12px 6px',
                    borderRadius: 14,
                    background: 'rgba(252, 247, 250, 0.92)',
                    border: '1px solid rgba(241, 230, 236, 0.95)',
                  }}
                >
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setLarkGroupExpanded((prev) => !prev)
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: '#6B5060',
                          marginBottom: 2,
                        }}
                      >
                        Lark 官方技能
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: '#9A98A1',
                        }}
                      >
                        {larkSuggestions.length} 个已安装技能，按需展开调用
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: '#A1A1AA',
                        transform: larkGroupExpanded || larkQuery ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.15s ease',
                      }}
                    >
                      ▸
                    </div>
                  </button>

                  {visibleLarkSuggestions.map(({ skill }, index) =>
                    renderSkillSuggestion(
                      skill,
                      visibleOtherSuggestions.length + index,
                      { inset: 18 }
                    )
                  )}

                  {hiddenLarkSkillCount > 0 && !(larkGroupExpanded || larkQuery) && (
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setLarkGroupExpanded(true)
                      }}
                      style={{
                        width: '100%',
                        marginTop: 4,
                        padding: '8px 12px 4px 30px',
                        border: 'none',
                        background: 'transparent',
                        color: '#C34C83',
                        fontSize: 12,
                        fontWeight: 600,
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      展开其余 {hiddenLarkSkillCount} 个 Lark skills
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: '0 16px 16px', fontSize: 12, color: '#A1A1AA' }}>
              {skillsLoadedOnce ? '没有匹配的 skill' : '暂无可用 skill'}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,247,250,0.92))',
          border: `2px solid ${focused ? 'rgba(255, 146, 197, 0.42)' : 'rgba(255, 146, 197, 0.28)'}`,
          borderRadius: 26,
          boxShadow: focused
            ? '0 0 0 3px rgba(255, 195, 221, 0.3), 0 18px 32px rgba(243, 184, 211, 0.16)'
            : '0 18px 32px rgba(243, 184, 211, 0.12)',
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
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  opacity: placeholderTipLeaving && !focused && queue.length === 0 ? 0 : 1,
                  transform:
                    placeholderTipLeaving && !focused && queue.length === 0
                      ? 'translateY(6px)'
                      : 'translateY(0)',
                  filter:
                    placeholderTipLeaving && !focused && queue.length === 0
                      ? 'blur(4px)'
                      : 'blur(0)',
                  transition: `opacity ${PLACEHOLDER_TIP_FADE_MS}ms ease, transform ${PLACEHOLDER_TIP_FADE_MS}ms ease, filter ${PLACEHOLDER_TIP_FADE_MS}ms ease`,
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
              onKeyUp={handleSelectionChange}
              onMouseUp={handleSelectionChange}
              onPaste={handlePaste}
              onFocus={() => {
                setFocused(true)
                void refreshSkills()
                handleSelectionChange()
              }}
              onBlur={() => {
                setFocused(false)
                setSlashState(null)
                setSlashIndex(0)
              }}
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
