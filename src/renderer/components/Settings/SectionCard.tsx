import React from 'react'
import { tokens } from './settingsStyles'

interface SectionCardProps {
  title: string
  subtitle?: string
  /** Right-aligned action (e.g. "+ 添加" button). Wraps below the title on
   * narrow widths so it never collides with the heading. */
  action?: React.ReactNode
  children: React.ReactNode
}

/**
 * Single section card in the settings page. Visually mirrors the chat
 * sidebar bubbles: white surface, hairline `#fce4ec` border, soft drop
 * shadow, system font. Header lays out title + action with `flex-wrap`
 * so narrow windows degrade gracefully (action drops below title rather
 * than getting clipped).
 */
export function SectionCard({
  title,
  subtitle,
  action,
  children,
}: SectionCardProps): React.ReactElement {
  return (
    <section
      style={{
        background: tokens.card,
        borderRadius: tokens.radiusCard,
        border: `1px solid ${tokens.border}`,
        padding: '14px 16px 16px',
        boxShadow: '0 2px 10px -4px rgba(255, 20, 147, 0.08)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: subtitle ? 4 : 12,
        }}
      >
        <h3
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: tokens.brandHeader,
            margin: 0,
            letterSpacing: '-0.1px',
          }}
        >
          {title}
        </h3>
        {action && <div style={{ flexShrink: 0 }}>{action}</div>}
      </header>
      {subtitle && (
        <p
          style={{
            fontSize: 11,
            color: tokens.inkMuted,
            margin: '0 0 12px',
            lineHeight: 1.5,
          }}
        >
          {subtitle}
        </p>
      )}
      <div>{children}</div>
    </section>
  )
}
