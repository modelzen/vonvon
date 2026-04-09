import React from 'react'

interface Props {
  percent: number
}

export function UsageRing({ percent }: Props): React.ReactElement {
  const p = Math.max(0, Math.min(100, Math.round(percent)))
  const radius = 14
  const circ = 2 * Math.PI * radius
  const offset = circ * (1 - p / 100)
  const color = p >= 80 ? '#E53935' : p >= 50 ? '#FF9800' : '#FF69B4'
  return (
    <div
      style={{
        position: 'absolute',
        right: 14,
        bottom: 78,
        width: 38,
        height: 38,
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.95)',
        boxShadow: '0 2px 8px rgba(255,105,180,0.18)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
        pointerEvents: 'none'
      }}
    >
      <svg
        width="38"
        height="38"
        viewBox="0 0 38 38"
        style={{ position: 'absolute', inset: 0 }}
      >
        <circle cx="19" cy="19" r={radius} fill="none" stroke="#f5f5f5" strokeWidth="3" />
        <circle
          cx="19"
          cy="19"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 19 19)"
          style={{ transition: 'stroke-dashoffset 400ms ease, stroke 200ms ease' }}
        />
      </svg>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          color,
          zIndex: 1,
          lineHeight: 1
        }}
      >
        {p}%
      </span>
    </div>
  )
}
