import React from 'react'

// ─── Settings design tokens — aligned with the chat sidebar ──────────────────
//
// Lives intentionally close to the inline-style palette already used by the
// chat page (#FF69B4 / #FF1493 / #fce4ec / #d81b60). System fonts only — no
// web fonts. Plain whites, hairline borders, soft shadows. The goal is for
// the settings window to feel like the same product as the chat surface,
// not a separate "design language" exercise.

export const tokens = {
  // Colors — same family as chat page
  canvas: '#fff8fb',
  card: '#ffffff',
  cardSoft: '#fffafc',
  border: '#fce4ec',
  borderSoft: '#fdeef3',
  ink: '#333333',
  inkSoft: '#666666',
  inkMuted: '#999999',
  inkFaint: '#bbbbbb',
  brand: '#FF69B4',
  brandStrong: '#FF1493',
  brandHeader: '#d81b60',
  petal: '#fff5f9',
  success: '#4caf50',
  warn: '#f5a623',
  danger: '#e53935',

  // Typography — system font only, matching chat page
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  monoFont: 'ui-monospace, SFMono-Regular, Menlo, monospace',

  // Shape
  radiusCard: 12,
  radiusControl: 8,
  radiusPill: 999,

  // Motion
  ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  durFast: '140ms',
  durMed: '240ms',

  // ─── Back-compat aliases ───────────────────────────────────────────────────
  // The first iteration of this file used a "Sakura Calm" palette with
  // `displayFont`/`bodyFont` and `blossom*` color names. The user rejected
  // that direction, so the canonical names changed to system-font / brand
  // names. The aliases below let the McpServerPanel and SkillsPanel keep
  // working without a churn refactor — they map to the chat-page palette.
  displayFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  bodyFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  blossom: '#FF69B4',
  blossomStrong: '#FF1493',
  blossomDeep: '#FF1493',
  blossomSoft: '#fce4ec',
  inkHair: '#fce4ec',
  easeOut: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
} as const

// ─── Reusable style objects ──────────────────────────────────────────────────

export const pageStyle: React.CSSProperties = {
  height: '100vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  fontFamily: tokens.font,
  color: tokens.ink,
  background: 'linear-gradient(180deg, #fff5f9 0%, #ffffff 40%, #fff8fb 100%)',
}

export const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  // Left padding leaves room for macOS traffic lights (hiddenInset title
  // bar). The close/back button inside the header has been removed — users
  // close the settings window via the native red button.
  padding: '12px 18px 12px 86px',
  borderBottom: `1px solid ${tokens.border}`,
  background: 'rgba(255, 255, 255, 0.92)',
  backdropFilter: 'saturate(180%) blur(16px)',
  WebkitBackdropFilter: 'saturate(180%) blur(16px)',
  flexShrink: 0,
  // Make the header area draggable so the user can move the window
  // anywhere (hiddenInset keeps a draggable title bar strip).
  WebkitAppRegion: 'drag' as any,
}

export const headerTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: tokens.ink,
  letterSpacing: '-0.1px',
}

export const closeBtnStyle: React.CSSProperties = {
  border: 'none',
  background: 'rgba(255, 105, 180, 0.08)',
  borderRadius: 8,
  width: 28,
  height: 28,
  cursor: 'pointer',
  color: tokens.brand,
  fontSize: 14,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: `background ${tokens.durFast} ${tokens.ease}`,
}

export const scrollAreaStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '20px 22px 32px',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  // Cap content width so wide windows don't sprawl text across the screen.
  // The actual rendered width still adapts; this just prevents very wide
  // displays from making rows look lonely.
  maxWidth: 720,
  width: '100%',
  alignSelf: 'center',
  boxSizing: 'border-box',
}

// ─── Form controls ───────────────────────────────────────────────────────────

export const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: tokens.inkSoft,
  display: 'block',
  marginBottom: 5,
  fontWeight: 500,
}

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 12,
  fontFamily: tokens.font,
  color: tokens.ink,
  border: `1px solid ${tokens.border}`,
  borderRadius: tokens.radiusControl,
  outline: 'none',
  boxSizing: 'border-box',
  background: '#fff',
  transition: `border-color ${tokens.durFast} ${tokens.ease}, box-shadow ${tokens.durFast} ${tokens.ease}`,
}

export const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

export const btnPrimaryStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: tokens.font,
  borderRadius: tokens.radiusControl,
  border: 'none',
  background: `linear-gradient(135deg, ${tokens.brand}, ${tokens.brandStrong})`,
  color: '#fff',
  cursor: 'pointer',
  boxShadow: '0 2px 8px -2px rgba(255, 20, 147, 0.35)',
  transition: `transform ${tokens.durFast} ${tokens.ease}, box-shadow ${tokens.durFast} ${tokens.ease}`,
  whiteSpace: 'nowrap',
}

export const btnGhostStyle: React.CSSProperties = {
  padding: '5px 12px',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: tokens.font,
  borderRadius: tokens.radiusControl,
  border: `1px solid ${tokens.brand}`,
  background: '#fff',
  color: tokens.brand,
  cursor: 'pointer',
  transition: `all ${tokens.durFast} ${tokens.ease}`,
  whiteSpace: 'nowrap',
}

export function applyFocusRing(e: React.FocusEvent<HTMLElement>, focused: boolean): void {
  const el = e.currentTarget as HTMLElement
  if (focused) {
    el.style.borderColor = tokens.brand
    el.style.boxShadow = `0 0 0 3px ${tokens.petal}`
  } else {
    el.style.borderColor = tokens.border
    el.style.boxShadow = 'none'
  }
}
