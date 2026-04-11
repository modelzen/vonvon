import React, { useState } from 'react'

interface Props {
  percent: number
}

export function UsageRing({ percent }: Props): React.ReactElement {
  const [hovered, setHovered] = useState(false)
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
      style={{ position: 'relative', width: size, height: size, flexShrink: 0, cursor: 'help' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Tooltip above ring */}
      <div
        style={{
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          left: '50%',
          transform: `translateX(-50%) translateY(${hovered ? 0 : 4}px)`,
          background: '#1f1f1f',
          color: '#fff',
          fontSize: 10.5,
          fontWeight: 500,
          padding: '4px 9px',
          borderRadius: 6,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          opacity: hovered ? 1 : 0,
          transition: 'opacity 180ms ease, transform 180ms ease',
          zIndex: 100,
        }}
      >
        {`上下文 ${p}%`}
        {/* Triangle arrow pointing down */}
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 0,
            height: 0,
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderTop: '4px solid #1f1f1f',
          }}
        />
      </div>

      {/* SVG ring */}
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

      {/* Centered percentage — visible only on hover */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: hovered ? 1 : 0,
          transition: 'opacity 150ms ease',
        }}
      >
        <span
          style={{
            fontSize: 8,
            fontWeight: 700,
            color,
            lineHeight: 1,
            letterSpacing: '-0.2px',
          }}
        >
          {p}%
        </span>
      </div>
    </div>
  )
}
