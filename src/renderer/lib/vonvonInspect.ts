export const VONVON_INSPECT_MARKER = '【vonvon-inspect】'
const VONVON_INSPECT_VARIANT_PREFIX = `${VONVON_INSPECT_MARKER}::`
const VONVON_INSPECT_BODIES = [
  '我先探个小脑袋，去把这页的重点和待办叼回来。',
  '我轻轻蹭进来啦，先帮你把眼前这摊事理一理。',
  '别急，我先帮你捞一捞重点，顺手把线头拢好。',
  '我先贴过来看看，马上把要紧的几件事捧给你。',
  '我先帮你理理这一页，看看重点、待办和下一步都落在哪。',
  '我先去转一圈，把重要消息和没收好的尾巴一起拎回来。',
  '我先帮你扫一遍，把现在最值得关心的东西挑出来。',
] as const

export interface VonvonInspectCardPayload {
  headline: string
  body: string
}

export function createVonvonInspectCardContent(): string {
  const index = Math.floor(Math.random() * VONVON_INSPECT_BODIES.length)
  return `${VONVON_INSPECT_VARIANT_PREFIX}${index}`
}

export function parseVonvonInspectCard(content: string): VonvonInspectCardPayload | null {
  if (!content.startsWith(VONVON_INSPECT_MARKER)) return null
  const suffix = content.slice(VONVON_INSPECT_VARIANT_PREFIX.length).trim()
  const parsedIndex = Number.parseInt(suffix, 10)
  const body =
    Number.isInteger(parsedIndex) &&
    parsedIndex >= 0 &&
    parsedIndex < VONVON_INSPECT_BODIES.length
      ? VONVON_INSPECT_BODIES[parsedIndex]
      : VONVON_INSPECT_BODIES[0]
  return {
    headline: 'von... von...',
    body,
  }
}
