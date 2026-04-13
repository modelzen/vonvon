import React, { useEffect, useState } from 'react'

// ── File type metadata ────────────────────────────────────────────────────────

interface FileTypeInfo {
  label: string   // short badge text
  color: string   // chip background color
  textColor: string
}

export function getFileTypeInfo(filename: string): FileTypeInfo {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'py':
      return { label: 'PY', color: '#2E7D32', textColor: '#fff' }
    case 'js':
    case 'jsx':
    case 'mjs':
      return { label: 'JS', color: '#F57F17', textColor: '#fff' }
    case 'ts':
    case 'tsx':
      return { label: 'TS', color: '#1565C0', textColor: '#fff' }
    case 'md':
    case 'mdx':
      return { label: 'MD', color: '#1976D2', textColor: '#fff' }
    case 'pdf':
      return { label: 'PDF', color: '#C62828', textColor: '#fff' }
    case 'json':
      return { label: '{}', color: '#E65100', textColor: '#fff' }
    case 'html':
    case 'css':
    case 'scss':
    case 'sass':
      return { label: '<>', color: '#BF360C', textColor: '#fff' }
    case 'txt':
    case 'log':
    case 'csv':
      return { label: 'TXT', color: '#757575', textColor: '#fff' }
    default:
      return { label: ext.toUpperCase().slice(0, 3) || 'FILE', color: '#616161', textColor: '#fff' }
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
}

export function FileChip({ path, onRemove, disabled }: FileChipProps): React.ReactElement {
  const filename = path.split('/').pop() ?? path
  const { label, color, textColor } = getFileTypeInfo(filename)
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
  const chipBg = isDisabled ? '#ececec' : '#f6f8ff'
  const badgeBg = isDisabled ? '#9e9e9e' : color

  return (
    <span
      title={path}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        background: chipBg,
        borderRadius: 999,
        padding: '2px 7px 2px 4px',
        fontSize: 12,
        lineHeight: '18px',
        color: isDisabled ? '#7d7d7d' : '#2e3650',
        verticalAlign: 'middle',
        maxWidth: 260,
        overflow: 'hidden',
        flexShrink: 0,
        userSelect: 'none',
        cursor: isDisabled ? 'default' : 'pointer',
        margin: '0 2px',
        border: `1px solid ${isDisabled ? '#d6d6d6' : 'rgba(49, 120, 198, 0.18)'}`,
        pointerEvents: onRemove ? 'auto' : 'none',
      }}
    >
      {/* File-type badge */}
      <span
        style={{
          background: badgeBg,
          color: textColor,
          borderRadius: 4,
          padding: '0 4px',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          lineHeight: '16px',
          flexShrink: 0,
          letterSpacing: '-0.3px',
        }}
      >
        {label}
      </span>

      {/* Filename */}
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 11.5,
          minWidth: 0,
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
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: 'none',
            background: isDisabled ? 'rgba(0,0,0,0.08)' : 'rgba(49, 120, 198, 0.12)',
            color: isDisabled ? '#666' : '#31589a',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            flexShrink: 0,
            fontSize: 10,
            lineHeight: 1,
            marginLeft: 1,
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
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
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
}

export function SkillChip({ name, onRemove }: SkillChipProps): React.ReactElement {
  const accent = '#B83280'
  const bg = '#FFF1F7'
  const border = 'rgba(184, 50, 128, 0.18)'

  return (
    <span
      title={name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: bg,
        borderRadius: 999,
        padding: '2px 8px 2px 6px',
        fontSize: 12,
        lineHeight: '18px',
        color: accent,
        verticalAlign: 'middle',
        maxWidth: 240,
        overflow: 'hidden',
        flexShrink: 0,
        userSelect: 'none',
        margin: '0 2px',
        border: `1px solid ${border}`,
        pointerEvents: onRemove ? 'auto' : 'none',
      }}
    >
      <SkillCubeIcon color={accent} />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          fontWeight: 600,
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
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(184, 50, 128, 0.12)',
            color: accent,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            flexShrink: 0,
            fontSize: 10,
            lineHeight: 1,
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
}

/**
 * Splits a message string into plain text segments and @file: chip segments,
 * rendering them inline. Used in message bubbles (read-only).
 */
export function FileChipRenderer({ text }: FileChipRendererProps): React.ReactElement {
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
        <FileChip key={`f-${ref.start}`} path={ref.path} />
      ) : (
        <SkillChip key={`s-${ref.start}`} name={ref.name} />
      )
    )
    cursor = ref.end
  }
  if (cursor < text.length) {
    parts.push(<span key={`t-${cursor}`}>{text.slice(cursor)}</span>)
  }
  return <>{parts}</>
}
