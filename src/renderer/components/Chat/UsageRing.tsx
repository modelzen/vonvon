import React from 'react'

interface Props {
  percent: number
}

// Compact context-usage ring intended to live inside the top header strip
// alongside the settings/close buttons. Previously this was absolute-
// positioned over the message list, which covered the tail of long
// conversations. Now it's a flow element so messages can breathe.
export function UsageRing({ percent }: Props): React.ReactElement {
  const p = Math.max(0, Math.min(100, Math.round(percent)))
  const size = 28
  const strokeWidth = 2.5
  const radius = (size - strokeWidth) / 2
  const center = size / 2
  const circ = 2 * Math.PI * radius
  const offset = circ * (1 - p / 100)
  const color = p >= 80 ? '#E53935' : p >= 50 ? '#FF9800' : '#FF69B4'
  return (
    <div
      title={`上下文已使用 ${p}%`}
      style={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ position: 'absolute', inset: 0 }}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#fce4ec"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
          style={{ transition: 'stroke-dashoffset 400ms ease, stroke 200ms ease' }}
        />
      </svg>
      <span
        style={{
          fontSize: 8,
          fontWeight: 700,
          color,
          lineHeight: 1,
          letterSpacing: '-0.2px'
        }}
      >
        {p}%
      </span>
    </div>
  )
}
