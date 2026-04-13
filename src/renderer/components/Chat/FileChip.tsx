import React, { useEffect, useState } from 'react'

// ── File type metadata ────────────────────────────────────────────────────────

interface FileTypeInfo {
  label: string
  accent: string
  titleColor: string
}

export type ChipTone = 'default' | 'user'

function hexToRgba(hex: string, alpha: number): string {
  const raw = hex.replace('#', '')
  const full = raw.length === 3 ? raw.split('').map((char) => char + char).join('') : raw
  const value = parseInt(full, 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function getFileTypeInfo(filename: string): FileTypeInfo {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'py':
      return { label: 'PY', accent: '#4B9654', titleColor: '#407C47' }
    case 'js':
    case 'jsx':
    case 'mjs':
      return { label: 'JS', accent: '#D07D21', titleColor: '#B86C1A' }
    case 'ts':
    case 'tsx':
      return { label: 'TS', accent: '#2F73C0', titleColor: '#2A67AB' }
    case 'md':
    case 'mdx':
      return { label: 'MD', accent: '#3680D7', titleColor: '#2F73C0' }
    case 'pdf':
      return { label: 'PDF', accent: '#D44B61', titleColor: '#BA4055' }
    case 'json':
      return { label: '{}', accent: '#CC8B2F', titleColor: '#B87722' }
    case 'html':
    case 'css':
    case 'scss':
    case 'sass':
      return { label: '<>', accent: '#C0673D', titleColor: '#A95A37' }
    case 'txt':
    case 'log':
    case 'csv':
      return { label: 'TXT', accent: '#8D8D93', titleColor: '#7E7E86' }
    default:
      return {
        label: ext.toUpperCase().slice(0, 4) || 'FILE',
        accent: '#9B7D8D',
        titleColor: '#836875',
      }
  }
}

// ── @file: reference parser ───────────────────────────────────────────────────

export interface FileReference {
  raw: string      // the full @file:... token as it appears in text
  path: string     // the resolved absolute path
  filename: string // basename for display
  start: number
  end: number
}

/** Parse all @file: tokens from a message string.
 *  Supports:
 *    @file:/abs/path/to/file.ext
 *    @file:"/abs/path with spaces/file.ext"
 */
export function parseFileReferences(text: string): FileReference[] {
  const re = /@file:(?:"([^"]+)"|(\S+))/g
  const refs: FileReference[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const path = (m[1] ?? m[2]).trim()
    const filename = path.split('/').pop() ?? path
    refs.push({
      raw: m[0],
      path,
      filename,
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return refs
}

/** Build a @file: token string from an absolute path. */
export function buildFileReference(absPath: string): string {
  // Wrap in quotes if path contains spaces
  return absPath.includes(' ')
    ? `@file:"${absPath}"`
    : `@file:${absPath}`
}

// ── @skill: reference parser ──────────────────────────────────────────────────

export interface SkillReference {
  raw: string
  name: string
  start: number
  end: number
}

/** Parse all @skill: tokens from a message string.
 *  Supports:
 *    @skill:checkpoint
 *    @skill:"Claude to Im"
 */
export function parseSkillReferences(text: string): SkillReference[] {
  const re = /@skill:(?:"([^"]+)"|(\S+))/g
  const refs: SkillReference[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const name = (m[1] ?? m[2]).trim()
    refs.push({
      raw: m[0],
      name,
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return refs
}

/** Build a @skill: token string from a skill name. */
export function buildSkillReference(name: string): string {
  return name.includes(' ') ? `@skill:"${name}"` : `@skill:${name}`
}

export type InlineReference =
  | ({ kind: 'file' } & FileReference)
  | ({ kind: 'skill' } & SkillReference)

export function parseInlineReferences(text: string): InlineReference[] {
  return [
    ...parseFileReferences(text).map((ref) => ({ ...ref, kind: 'file' as const })),
    ...parseSkillReferences(text).map((ref) => ({ ...ref, kind: 'skill' as const })),
  ].sort((a, b) => a.start - b.start)
}

// ── FileChip component ────────────────────────────────────────────────────────

interface FileChipProps {
  path: string
  /** When provided, shows a × remove button (editable mode). */
  onRemove?: () => void
  /** Gray out the chip (e.g. file no longer exists in history). */
  disabled?: boolean
  tone?: ChipTone
}

export function FileChip({
  path,
  onRemove,
  disabled,
  tone = 'default',
}: FileChipProps): React.ReactElement {
  const filename = path.split('/').pop() ?? path
  const { label, accent, titleColor } = getFileTypeInfo(filename)
  const [exists, setExists] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!path.startsWith('/')) {
      setExists(true)
      return
    }
    const fileExists = window.electron?.fileExists
    if (!fileExists) {
      setExists(true)
      return
    }
    void fileExists(path)
      .then((result) => {
        if (!cancelled) setExists(result)
      })
      .catch(() => {
        if (!cancelled) setExists(true)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  const isDisabled = disabled || exists === false
  const isUserTone = tone === 'user'
  const chipBg = isDisabled
    ? 'rgba(120, 128, 140, 0.12)'
    : isUserTone
      ? hexToRgba(accent, 0.09)
      : hexToRgba(accent, 0.09)
  const chipBorder = isDisabled
    ? 'rgba(120, 128, 140, 0.18)'
    : isUserTone
      ? hexToRgba(accent, 0.16)
      : hexToRgba(accent, 0.12)
  const labelColor = isDisabled ? '#9ca3af' : accent
  const filenameColor = isDisabled ? '#7d7d7d' : titleColor
  const removeColor = isDisabled ? '#9ca3af' : accent

  return (
    <span
      title={path}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        background: chipBg,
        borderRadius: 10,
        padding: '0 7px',
        fontSize: 11.5,
        lineHeight: '18px',
        color: filenameColor,
        verticalAlign: 'middle',
        maxWidth: isUserTone ? 224 : 236,
        overflow: 'hidden',
        flexShrink: 0,
        userSelect: 'none',
        cursor: isDisabled ? 'default' : 'pointer',
        margin: '0 2px',
        border: `1px solid ${chipBorder}`,
        pointerEvents: onRemove ? 'auto' : 'none',
      }}
    >
      <span
        style={{
          color: labelColor,
          fontSize: 10,
          fontWeight: 700,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          lineHeight: '16px',
          flexShrink: 0,
          letterSpacing: '-0.08px',
          textTransform: 'lowercase',
        }}
      >
        {label.toLowerCase()}
      </span>

      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 11.5,
          minWidth: 0,
          fontWeight: 650,
          letterSpacing: '-0.1px',
        }}
      >
        {filename}
      </span>

      {/* Remove button (editable mode only) */}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="移除"
          style={{
            width: 11,
            height: 11,
            borderRadius: 0,
            border: 'none',
            background: 'transparent',
            color: removeColor,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            flexShrink: 0,
            fontSize: 11,
            lineHeight: 1,
            marginLeft: 1,
            opacity: 0.72,
          }}
        >
          ×
        </button>
      )}
    </span>
  )
}

function SkillCubeIcon({ color }: { color: string }): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5.5 6.75v10.5L12 21l6.5-3.75V6.75L12 3Z" />
      <path d="M12 3v7.5m0 0 6.5-3.75M12 10.5 5.5 6.75" />
    </svg>
  )
}

interface SkillChipProps {
  name: string
  onRemove?: () => void
  tone?: ChipTone
}

export function SkillChip({
  name,
  onRemove,
  tone = 'default',
}: SkillChipProps): React.ReactElement {
  const accent = '#CF4580'
  const titleColor = '#B63C74'
  const bg = hexToRgba(accent, 0.09)
  const border = hexToRgba(accent, tone === 'user' ? 0.16 : 0.12)
  const text = titleColor
  const icon = accent

  return (
    <span
      title={name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        background: bg,
        borderRadius: 10,
        padding: '0 7px',
        fontSize: 11.5,
        lineHeight: '18px',
        color: text,
        verticalAlign: 'middle',
        maxWidth: tone === 'user' ? 214 : 220,
        overflow: 'hidden',
        flexShrink: 0,
        userSelect: 'none',
        margin: '0 2px',
        border: `1px solid ${border}`,
        pointerEvents: onRemove ? 'auto' : 'none',
      }}
    >
      <SkillCubeIcon color={icon} />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          fontWeight: 650,
          letterSpacing: '-0.1px',
        }}
      >
        {name}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="移除"
          style={{
            width: 11,
            height: 11,
            borderRadius: 0,
            border: 'none',
            background: 'transparent',
            color: accent,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            flexShrink: 0,
            fontSize: 11,
            lineHeight: 1,
            opacity: 0.72,
          }}
        >
          ×
        </button>
      )}
    </span>
  )
}

// ── FileChipRenderer ──────────────────────────────────────────────────────────

interface FileChipRendererProps {
  text: string
  tone?: ChipTone
}

/**
 * Splits a message string into plain text segments and @file: chip segments,
 * rendering them inline. Used in message bubbles (read-only).
 */
export function FileChipRenderer({
  text,
  tone = 'default',
}: FileChipRendererProps): React.ReactElement {
  const refs = parseInlineReferences(text)
  if (refs.length === 0) return <>{text}</>

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const ref of refs) {
    if (ref.start > cursor) {
      parts.push(<span key={`t-${cursor}`}>{text.slice(cursor, ref.start)}</span>)
    }
    parts.push(
      ref.kind === 'file' ? (
        <FileChip key={`f-${ref.start}`} path={ref.path} tone={tone} />
      ) : (
        <SkillChip key={`s-${ref.start}`} name={ref.name} tone={tone} />
      )
    )
    cursor = ref.end
  }
  if (cursor < text.length) {
    parts.push(<span key={`t-${cursor}`}>{text.slice(cursor)}</span>)
  }
  return <>{parts}</>
}
