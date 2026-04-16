import React, { useMemo, useState } from 'react'
import { AboutSection } from './AboutSection'
import { HermesModelPanel } from './HermesModelPanel'
import { HermesAuthPanel } from './HermesAuthPanel'
import { McpServerPanel } from './McpServerPanel'
import { SkillsPanel } from './SkillsPanel'
import { ChatPreferencesPanel } from './ChatPreferencesPanel'
import { FeishuIntegrationPanel } from './FeishuIntegrationPanel'
import {
  pageStyle,
  headerStyle,
  headerTitleStyle,
  scrollAreaStyle,
  tokens,
} from './settingsStyles'

type SettingsPage = {
  id: string
  title: string
  description: string
  accent: string
  render: () => React.ReactNode
}

export function SettingsPanel(): React.ReactElement {
  const [activePageId, setActivePageId] = useState('general')
  const [visitedPageIds, setVisitedPageIds] = useState<string[]>(['general'])
  const [generalRefreshToken, setGeneralRefreshToken] = useState(0)

  const settingsPages = useMemo<SettingsPage[]>(
    () => [
      {
        id: 'general',
        title: '模型相关',
        description: '账号凭证、模型可见性和聊天偏好统一放在模型配置页里处理。',
        accent: '#ff5f95',
        render: () => (
          <>
            <HermesAuthPanel
              onCredentialsChanged={() => setGeneralRefreshToken((token) => token + 1)}
            />
            <HermesModelPanel refreshToken={generalRefreshToken} />
            <ChatPreferencesPanel refreshToken={generalRefreshToken} />
          </>
        ),
      },
      {
        id: 'mcp',
        title: 'MCP 服务',
        description: '连接外部工具服务，让 agent 能调用更多上下文能力。',
        accent: '#ff7c9e',
        render: () => <McpServerPanel />,
      },
      {
        id: 'feishu',
        title: '飞书集成',
        description: '托管官方 Lark CLI，统一处理安装、登录、升级和 vonvon 内部能力开关。',
        accent: '#ff6b9b',
        render: () => <FeishuIntegrationPanel />,
      },
      {
        id: 'skills',
        title: '技能中心',
        description: '查看已装技能，并按需同步、发现和安装更多 skill。',
        accent: '#ff4f86',
        render: () => <SkillsPanel />,
      },
      {
        id: 'about',
        title: '关于',
        description: '查看版本与客户端信息。',
        accent: '#ff93c5',
        render: () => <AboutSection />,
      },
    ],
    [generalRefreshToken]
  )

  const activePage = useMemo(
    () => settingsPages.find((page) => page.id === activePageId) ?? settingsPages[0],
    [activePageId, settingsPages]
  )

  const visitedPages = useMemo(
    () => settingsPages.filter((page) => visitedPageIds.includes(page.id)),
    [settingsPages, visitedPageIds]
  )

  const openPage = (pageId: string) => {
    setActivePageId(pageId)
    setVisitedPageIds((prev) => (prev.includes(pageId) ? prev : [...prev, pageId]))
  }

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <span style={headerTitleStyle}>设置</span>
      </div>

      <div
        style={{
          ...scrollAreaStyle,
          maxWidth: 1320,
          padding: '24px 30px 38px',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '220px minmax(0, 1fr)',
            gap: 30,
            width: '100%',
            alignItems: 'start',
          }}
        >
          <aside
            style={{
              position: 'sticky',
              top: 0,
              alignSelf: 'start',
              paddingTop: 8,
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: 2,
                textTransform: 'uppercase',
                color: tokens.brandStrong,
                fontWeight: 700,
                marginBottom: 16,
              }}
            >
              Settings
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {settingsPages.map((page) => {
                const active = page.id === activePage.id
                return (
                  <button
                    key={page.id}
                    onClick={() => openPage(page.id)}
                    style={{
                      textAlign: 'left',
                      border: 'none',
                      borderRadius: 18,
                      background: active ? 'rgba(255, 255, 255, 0.96)' : 'transparent',
                      padding: '12px 14px',
                      cursor: 'pointer',
                      boxShadow: active ? '0 18px 30px -26px rgba(255, 20, 147, 0.45)' : 'none',
                      outline: 'none',
                      transition: 'all 160ms ease',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 6,
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: active ? page.accent : 'rgba(255, 20, 147, 0.15)',
                          flexShrink: 0,
                        }}
                      />
                      <div
                        style={{
                          fontSize: 15,
                          fontWeight: 700,
                          color: tokens.ink,
                        }}
                      >
                        {page.title}
                      </div>
                    </div>

                    <div
                      style={{
                        fontSize: 11,
                        lineHeight: 1.55,
                        color: tokens.inkSoft,
                        marginTop: 2,
                      }}
                    >
                      {page.description}
                    </div>
                  </button>
                )
              })}
            </div>
          </aside>

          <main style={{ minWidth: 0 }}>
            <div style={{ padding: '8px 0 18px' }}>
              <div
                style={{
                  width: 34,
                  height: 5,
                  borderRadius: 999,
                  background: activePage.accent,
                  boxShadow: `0 10px 20px -16px ${activePage.accent}`,
                }}
              />
              <div
                style={{
                  fontSize: 34,
                  lineHeight: 1.06,
                  fontWeight: 700,
                  color: tokens.ink,
                  marginTop: 14,
                }}
              >
                {activePage.title}
              </div>
              <div
                style={{
                  fontSize: 14,
                  lineHeight: 1.7,
                  color: tokens.inkSoft,
                  marginTop: 10,
                  maxWidth: 620,
                }}
              >
                {activePage.description}
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              {visitedPages.map((page) => {
                const isActive = page.id === activePage.id
                return (
                  <div
                    key={page.id}
                    hidden={!isActive}
                    style={{ display: isActive ? 'flex' : 'none', flexDirection: 'column', gap: 14 }}
                  >
                    {page.render()}
                  </div>
                )
              })}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
