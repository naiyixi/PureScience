import { useId, useMemo, useState } from 'react'

import { useLanguage } from '@/i18n'
import { Send, X } from 'lucide-react'

import { Button } from '@/components/ui/button'

// Side chat: a lightweight, ephemeral conversation that runs alongside the main session. The user
// can draft notes/questions here and forward them into the active session — while the agent is
// running the main turn is interrupted first, then the advisory is sent (ACP has no mid-turn input,
// so interrupt-then-send is the protocol-compatible approximation of live injection).

type SideChatMessage = {
  id: string
  role: 'user' | 'system'
  text: string
}

type SideChatPanelProps = {
  isOpen: boolean
  onClose: () => void
  onForward: (advisory: string) => void
  isSessionRunning: boolean
  sessionTitle?: string
}

export const SideChatPanel = ({
  isOpen,
  onClose,
  onForward,
  isSessionRunning,
  sessionTitle
}: SideChatPanelProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  const [messages, setMessages] = useState<SideChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const nextId = useId()

  const canForward = useMemo(
    () => messages.some((message) => message.role === 'user'),
    [messages]
  )

  if (!isOpen) return null

  const handleSend = (): void => {
    const text = draft.trim()
    if (!text) return
    setMessages((current) => [
      ...current,
      { id: `${nextId}-${current.length}`, role: 'user', text }
    ])
    setDraft('')
  }

  const handleForward = (): void => {
    if (!canForward) return
    const advisory = messages
      .filter((message) => message.role === 'user')
      .map((message) => message.text)
      .join('\n\n')
    onForward(advisory)
  }

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-card text-card-foreground">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{t('ws.sideChatTitle')}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {isSessionRunning ? t('ws.sideChatRunning') : t('ws.sideChatIdle')}
            {sessionTitle ? ` · ${sessionTitle}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={!canForward}
            onClick={handleForward}
            title={t('ws.sideChatForwardHint')}
          >
            {t('ws.sideChatForward')}
          </Button>
          <Button type="button" size="icon" variant="ghost" onClick={onClose} aria-label={t('common.close')}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t('ws.sideChatEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`max-w-[90%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
                  message.role === 'user'
                    ? 'self-end bg-primary text-primary-foreground'
                    : 'self-start bg-muted text-muted-foreground'
                }`}
              >
                {message.text}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                handleSend()
              }
            }}
            rows={2}
            placeholder={t('ws.sideChatPlaceholder')}
            className="min-h-9 flex-1 resize-none rounded-md border border-border bg-bg-00 px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
          <Button
            type="button"
            size="icon"
            onClick={handleSend}
            disabled={draft.trim().length === 0}
            aria-label={t('ws.sideChatSend')}
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </aside>
  )
}
