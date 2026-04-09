import React from 'react'

interface UsageBarProps {
  percent: number
}

function getBarColor(percent: number): string {
  if (percent >= 95) return '#f44336'
  if (percent >= 80) return '#ff9800'
  if (percent >= 60) return '#ffeb3b'
  return '#4caf50'
}

export function UsageBar({ percent }: UsageBarProps): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, percent))
  const color = getBarColor(clamped)

  return (
    <div style={{ padding: '4px 12px 2px' }}>
      <div
        style={{
          height: 4,
          borderRadius: 2,
          background: 'rgba(0,0,0,0.08)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${clamped}%`,
            background: color,
            borderRadius: 2,
            transition: 'width 0.4s ease, background 0.4s ease'
          }}
        />
      </div>
      <div
        style={{
          fontSize: 10,
          color: '#aaa',
          textAlign: 'right',
          marginTop: 1
        }}
      >
        {clamped}% context used
      </div>
    </div>
  )
}
