export const VONVON_INSPECT_MARKER = '【vonvon-inspect】'

export const VONVON_INSPECT_BODY =
  '判断出图中我当前关注的协同应用上下文，然后调用相关 skills 去获取更完整、更新的上下文。结合我现在可能要做的事，主动提供帮助。'

export const VONVON_INSPECT_MESSAGE = `${VONVON_INSPECT_MARKER}\n${VONVON_INSPECT_BODY}`

export interface VonvonInspectCardPayload {
  title: string
  body: string
}

export function parseVonvonInspectCard(content: string): VonvonInspectCardPayload | null {
  if (!content.startsWith(VONVON_INSPECT_MARKER)) return null
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const body = lines.slice(1).join('\n').trim()
  return {
    title: 'vonvon-inspect',
    body: body || VONVON_INSPECT_BODY,
  }
}
