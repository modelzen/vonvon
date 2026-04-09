import React from 'react'

interface StreamingTextProps {
  content: string
  isStreaming?: boolean
}

export function StreamingText({ content, isStreaming }: StreamingTextProps): React.ReactElement {
  return (
    <span className="whitespace-pre-wrap break-words">
      {content}
      {isStreaming && (
        <span className="inline-block w-2 h-4 bg-current opacity-70 ml-0.5 animate-pulse" />
      )}
    </span>
  )
}
