import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentMessage } from '../../hooks/useAgentChat'

interface Props {
  messages: AgentMessage[]
  isLoading: boolean
  thinking?: string
}

function flattenContent(content: string): string {
  return content.replace(/\s*\n+\s*/g, ' ').trim()
}

// Custom markdown component map. The primary job here is to intercept
// link clicks — vanilla <a> in an Electron renderer will navigate the
// window to the href and replace our entire app, with no back button.
// We route http(s) URLs through window.electron.openExternal so they
// launch in the user's default browser instead.
const markdownComponents = {
  a: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault()
      if (!href) return
      if (/^https?:\/\//i.test(href)) {
        try {
          ;(window as unknown as {
            electron?: { openExternal?: (url: string) => void }
          }).electron?.openExternal?.(href)
        } catch {
          // Best-effort: if the bridge isn't there we just do nothing,
          // which is still safer than navigating the whole window.
        }
      }
    }
    return (
      <a {...rest} href={href} onClick={handleClick} style={{ cursor: 'pointer' }}>
        {children}
      </a>
    )
  }
}

// Small geometric status indicator that sits next to the tool name.
// Running state pulses so the user feels the call is alive; completed
// stays as a quiet pink dot so finished tools fade into the background;
// failed uses a red cross so errors pop without shouting.
function ToolStatusDot({
  status
}: {
  status?: 'running' | 'completed' | 'failed'
}): React.ReactElement {
  if (status === 'failed') {
    return (
      <span
        style={{
          display: 'inline-flex',
          width: 10,
          height: 10,
          alignItems: 'center',
          justifyContent: 'center',
          color: '#e53935',
          fontWeight: 700,
          fontSize: 11,
          lineHeight: 1
        }}
        aria-label="failed"
      >
        ✗
      </span>
    )
  }
  if (status === 'running') {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-label="running">
        <circle cx="5" cy="5" r="3" fill="#FF1493">
          <animate
            attributeName="r"
            values="2;3.8;2"
            dur="1.2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.45;1;0.45"
            dur="1.2s"
            repeatCount="indefinite"
          />
        </circle>
      </svg>
    )
  }
  // completed (or unspecified — treat as completed for historical entries).
  // Neutral grey keeps finished tools ambient; the pink pulse above is
  // reserved for the liveness signal.
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-label="completed">
      <circle cx="5" cy="5" r="2.4" fill="#d0d0d0" />
    </svg>
  )
}

function TypingDots(): React.ReactElement {
  // 3 pink dots pulsing in sequence via SVG SMIL (no CSS keyframes file needed).
  return (
    <svg width="28" height="8" viewBox="0 0 28 8" aria-label="loading">
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx={4 + i * 10}
          cy={4}
          r={2.5}
          fill="#FF69B4"
        >
          <animate
            attributeName="opacity"
            values="0.25;1;0.25"
            dur="1.2s"
            begin={`${i * 0.2}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values="2;3;2"
            dur="1.2s"
            begin={`${i * 0.2}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </svg>
  )
}

function renderMessage(msg: AgentMessage, isLoading: boolean): React.ReactElement | null {
  if (msg.role === 'user') {
    return (
      <div
        key={msg.id}
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 8
        }}
      >
        <div
          style={{
            maxWidth: '80%',
            padding: '8px 12px',
            borderRadius: 12,
            fontSize: 13,
            background: 'linear-gradient(135deg, #FF69B4, #FF1493)',
            color: '#fff',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {msg.attachments && msg.attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginBottom: msg.content ? 4 : 0, flexWrap: 'wrap' }}>
              {msg.attachments.map((a, i) => (
                <img
                  key={i}
                  src={a.dataUrl}
                  alt={a.name || 'image'}
                  style={{
                    maxWidth: 120,
                    maxHeight: 120,
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.3)',
                    display: 'block'
                  }}
                />
              ))}
            </div>
          )}
          {msg.content}
        </div>
      </div>
    )
  }

  if (msg.role === 'assistant') {
    const showPlaceholder = !msg.content && isLoading
    // Flat prose layout (inspired by the ChatGPT side-panel): no bubble,
    // no border, no background — the assistant's reply reads as body
    // copy that sits directly on the canvas. Only user messages keep
    // their pink bubble to preserve speaker identity at a glance.
    return (
      <div
        key={msg.id}
        style={{
          marginBottom: 12,
          fontSize: 13,
          color: '#333',
          lineHeight: 1.55,
          wordBreak: 'break-word'
        }}
      >
        {showPlaceholder ? (
          <TypingDots />
        ) : (
          <div className="vonvon-md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    )
  }

  // Tool cards live in their own component because they need per-row
  // React hooks (expanded state + status transition effect). They can't
  // be declared inside the plain `renderMessage` helper.
  if (msg.role === 'tool') return <ToolCard key={msg.id} msg={msg} />

  return null
}

// Expandable tool execution card. Behaviour:
//   • starts expanded while running so the user can see the live preview
//   • auto-collapses the instant the run finishes (feels clean)
//   • user can click the header to manually re-expand any card later
//   • collapsed view shows a single-line ellipsis preview as a teaser
//   • expanded view shows the full preview with a scrollable max-height
// These behaviours mirror the reference OpenAI/Claude tool UX the user
// pointed at.
function ToolCard({ msg }: { msg: AgentMessage }): React.ReactElement {
  const isFailed = msg.toolStatus === 'failed'
  const isRunning = msg.toolStatus === 'running'
  const preview = msg.toolPreview && msg.toolPreview.trim() ? msg.toolPreview : ''
  const canExpand = preview.length > 0

  const [expanded, setExpanded] = useState<boolean>(isRunning)
  const prevStatusRef = useRef(msg.toolStatus)

  useEffect(() => {
    const prev = prevStatusRef.current
    const cur = msg.toolStatus
    prevStatusRef.current = cur
    if (prev !== 'running' && cur === 'running') {
      setExpanded(true)
    } else if (
      prev === 'running' &&
      (cur === 'completed' || cur === 'failed')
    ) {
      setExpanded(false)
    }
  }, [msg.toolStatus])

  const durationText =
    msg.toolDuration && msg.toolDuration > 0 ? `· ${msg.toolDuration}s` : ''

  // Flat chip layout inspired by ChatGPT's inline tool summaries: a single
  // low-contrast monospaced row that sits between prose messages without
  // framing. No background wash, no border, no left rail — just dot +
  // name + duration + chevron. The expanded body is a subtle grey box.
  const headerColor = isFailed ? '#c33' : '#888'

  const handleToggle = () => {
    if (!canExpand) return
    setExpanded((e) => !e)
  }

  return (
    <div
      style={{
        margin: '0 0 8px 0',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
      }}
    >
      <div
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (!canExpand) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleToggle()
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: headerColor,
          lineHeight: 1.5,
          cursor: canExpand ? 'pointer' : 'default',
          userSelect: 'none'
        }}
      >
        <ToolStatusDot status={msg.toolStatus} />
        <span style={{ fontWeight: 500, letterSpacing: '-0.1px' }}>
          {msg.toolName || 'tool'}
        </span>
        {durationText && (
          <span style={{ color: '#bbb', fontSize: 10 }}>{durationText}</span>
        )}
        {canExpand && (
          <span
            aria-label={expanded ? 'collapse' : 'expand'}
            style={{
              marginLeft: 'auto',
              width: 10,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#bbb',
              transition: 'transform 150ms ease',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              fontSize: 9
            }}
          >
            ▸
          </span>
        )}
      </div>

      {canExpand && expanded && (
        <pre
          style={{
            marginTop: 5,
            marginBottom: 0,
            padding: '8px 10px',
            background: '#fafafa',
            border: '1px solid #f0f0f0',
            borderRadius: 6,
            fontSize: 10.5,
            color: '#555',
            maxHeight: 220,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.5,
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, monospace'
          }}
        >
          {preview}
        </pre>
      )}
    </div>
  )
}

// Transient reasoning indicator rendered at the bottom of the message list
// while a run is in flight. Deliberately kept outside the `messages` array
// so it disappears the moment the run finishes — thinking text is never
// persisted or scrolled into history.
function ThinkingIndicator({ text }: { text: string }): React.ReactElement | null {
  const flat = flattenContent(text)
  if (!flat) return null
  return (
    <div
      style={{
        padding: '3px 2px',
        fontSize: 11,
        color: '#aaa',
        fontStyle: 'italic',
        marginBottom: 3,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      💭 {flat}
    </div>
  )
}

export function AgentMessageList({ messages, isLoading, thinking }: Props): React.ReactElement {
  const endRef = useRef<HTMLDivElement>(null)
  // Auto-scroll when message count changes OR when the thinking indicator
  // first appears/disappears, so the footer stays in view during a run.
  const hasThinking = !!(isLoading && thinking && thinking.trim())
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, hasThinking])

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', minHeight: 0 }}>
      {messages.map((msg) => renderMessage(msg, isLoading))}
      {hasThinking && <ThinkingIndicator text={thinking as string} />}
      <div ref={endRef} />
    </div>
  )
}
