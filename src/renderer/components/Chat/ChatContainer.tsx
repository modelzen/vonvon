import React from 'react'
import { useChat } from '../../hooks/useChat'
import { MessageList } from './MessageList'
import { InputArea } from './InputArea'
import { ModelSelector } from './ModelSelector'

interface ChatContainerProps {
  defaultModel?: string
}

export function ChatContainer({ defaultModel = 'gpt-4o' }: ChatContainerProps): React.ReactElement {
  const { messages, isLoading, selectedModel, setSelectedModel, sendMessage, clearMessages } =
    useChat(defaultModel)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 14px', borderBottom: '1px solid #fce4ec',
        background: 'rgba(255,255,255,0.5)', flexShrink: 0
      }}>
        <ModelSelector selectedModel={selectedModel} onModelChange={setSelectedModel} />
        <button onClick={clearMessages} disabled={isLoading || messages.length === 0}
          style={{ marginLeft: 'auto', fontSize: 11, color: '#ddd', cursor: 'pointer',
            border: 'none', background: 'none', opacity: (isLoading || messages.length === 0) ? 0.3 : 1 }}>
          清空
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <MessageList messages={messages} isLoading={isLoading} />
      </div>
      <InputArea onSend={(msg) => sendMessage(msg)} isLoading={isLoading} />
    </div>
  )
}
