import React from 'react'
import type { WorkspaceState } from '../../hooks/useHermesConfig'

interface SandboxBannerProps {
  workspace: WorkspaceState
  onOpenSettings: () => void
}

export function SandboxBanner({ workspace, onOpenSettings }: SandboxBannerProps): React.ReactElement | null {
  if (!workspace.is_sandbox) return null

  return (
    <div style={{
      background: '#fff3cd',
      borderBottom: '1px solid #ffc107',
      padding: '5px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexShrink: 0,
    }}>
      <span style={{ fontSize: 12, color: '#856404', flex: 1 }}>
        ⚠️ 当前使用默认沙箱{' '}
        <code style={{ fontFamily: 'monospace', fontSize: 11 }}>{workspace.path}</code>
        ，选择一个项目目录以获得更好体验
      </span>
      <button
        onClick={onOpenSettings}
        style={{
          fontSize: 11,
          color: '#856404',
          background: 'none',
          border: '1px solid #ffc107',
          borderRadius: 4,
          padding: '2px 8px',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        设置
      </button>
    </div>
  )
}
