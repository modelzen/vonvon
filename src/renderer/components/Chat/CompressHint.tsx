import React, { useEffect, useCallback, useState } from 'react'
import { useBackend } from '../../hooks/useBackend'

interface CompressHintProps {
  percent: number
  sessionId: string
  onCompressed: (newPercent: number) => void
}

export function CompressHint({ percent, sessionId, onCompressed }: CompressHintProps): React.ReactElement | null {
  const { apiFetch } = useBackend()
  const [compressing, setCompressing] = useState(false)

  const doCompress = useCallback(async () => {
    if (compressing) return
    setCompressing(true)
    try {
      const res = await apiFetch('/api/chat/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId })
      })
      if (res.ok) {
        const data = await res.json() as { usage_percent: number }
        onCompressed(data.usage_percent ?? 0)
      }
    } catch {
      // ignore
    } finally {
      setCompressing(false)
    }
  }, [apiFetch, sessionId, onCompressed, compressing])

  // Auto-trigger compression when > 95%
  useEffect(() => {
    if (percent > 95 && !compressing) {
      doCompress()
    }
  }, [percent, compressing, doCompress])

  if (percent <= 80) return null

  const isAuto = percent > 95

  return (
    <div
      style={{
        margin: '0 12px 6px',
        padding: '6px 12px',
        borderRadius: 8,
        background: isAuto ? 'rgba(255,152,0,0.12)' : 'rgba(255,235,59,0.15)',
        border: `1px solid ${isAuto ? '#ff9800' : '#ffeb3b'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 12,
        color: isAuto ? '#e65100' : '#795548'
      }}
    >
      <span>
        {compressing
          ? '正在压缩...'
          : isAuto
          ? '上下文即将满，正在自动压缩...'
          : '上下文较满，建议压缩'}
      </span>
      {!isAuto && !compressing && (
        <button
          onClick={doCompress}
          style={{
            marginLeft: 10,
            padding: '2px 10px',
            fontSize: 11,
            borderRadius: 6,
            border: '1px solid #ffeb3b',
            background: '#fff9c4',
            color: '#795548',
            cursor: 'pointer',
            fontWeight: 600
          }}
        >
          压缩
        </button>
      )}
    </div>
  )
}
