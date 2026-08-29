import { useState } from 'react'
import { useLanguage } from '@/i18n'

import type {
  ElicitationAnswer,
  ElicitationRequestView
} from '../../../../shared/elicitation'

type ElicitationCardsProps = {
  requests: ElicitationRequestView[]
  onRespond: (elicitationId: string, action: 'accept' | 'decline', answers?: ElicitationAnswer) => void
}

// App-owned structured clarification card: the agent asks the user one or more questions with
// typed fields (single-select choices, free text, number, boolean, multi-select). Answers are
// returned to the agent as the blocking `elicitation/create` response.
const ElicitationCards = ({ requests, onRespond }: ElicitationCardsProps): React.JSX.Element | null => {
  if (requests.length === 0) return null

  return (
    <div className="flex flex-col gap-2 px-2 pb-2">
      {requests.map((request) => (
        <ElicitationCard key={request.id} request={request} onRespond={onRespond} />
      ))}
    </div>
  )
}

const ElicitationCard = ({
  request,
  onRespond
}: {
  request: ElicitationRequestView
  onRespond: ElicitationCardsProps['onRespond']
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [multiSelect, setMultiSelect] = useState<Record<string, string[]>>({})

  const setAnswer = (key: string, value: unknown): void => {
    setAnswers((current) => ({ ...current, [key]: value }))
  }

  const submit = (): void => {
    const content: ElicitationAnswer = {}
    for (const [key, value] of Object.entries(answers)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        content[key] = value
      }
    }
    for (const [key, values] of Object.entries(multiSelect)) {
      if (values.length > 0) content[key] = values
    }
    onRespond(request.id, 'accept', content)
  }

  const missingRequired = request.fields.some(
    (field) =>
      field.required &&
      (answers[field.key] === undefined ||
        answers[field.key] === '' ||
        (field.kind === 'array' && (multiSelect[field.key] ?? []).length === 0))
  )

  return (
    <div className="rounded-2xl border border-border-200 bg-bg-000 p-3 shadow-card">
      <p className="text-sm font-medium leading-5 text-text-000">{request.message}</p>
      <div className="mt-3 flex flex-col gap-3">
        {request.fields.map((field) => (
          <label key={field.key} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-100">
              {field.label}
              {field.required ? (
                <span className="text-danger-000"> *{t('ws.elicitationRequired')}</span>
              ) : null}
            </span>
            {field.choices ? (
              field.kind === 'array' ? (
                <div className="flex flex-wrap gap-1.5">
                  {field.choices.map((choice) => {
                    const selected = (multiSelect[field.key] ?? []).includes(choice)
                    return (
                      <button
                        key={choice}
                        type="button"
                        onClick={() =>
                          setMultiSelect((current) => ({
                            ...current,
                            [field.key]: selected
                              ? (current[field.key] ?? []).filter((item) => item !== choice)
                              : [...(current[field.key] ?? []), choice]
                          }))
                        }
                        className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                          selected
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border-200 bg-bg-100 text-text-100 hover:bg-bg-200'
                        }`}
                      >
                        {choice}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {field.choices.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      onClick={() => setAnswer(field.key, choice)}
                      className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                        answers[field.key] === choice
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border-200 bg-bg-100 text-text-100 hover:bg-bg-200'
                      }`}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
              )
            ) : field.kind === 'boolean' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAnswer(field.key, answers[field.key] !== true)}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                    answers[field.key] === true
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border-200 bg-bg-100 text-text-100 hover:bg-bg-200'
                  }`}
                >
                  {answers[field.key] === true ? `✓ ${t('ws.elicitationTrue')}` : t('ws.elicitationTrue')}
                </button>
                <button
                  type="button"
                  onClick={() => setAnswer(field.key, answers[field.key] !== false)}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                    answers[field.key] === false
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border-200 bg-bg-100 text-text-100 hover:bg-bg-200'
                  }`}
                >
                  {answers[field.key] === false ? `✓ ${t('ws.elicitationFalse')}` : t('ws.elicitationFalse')}
                </button>
              </div>
            ) : (
              <input
                type={field.kind === 'number' ? 'number' : 'text'}
                value={typeof answers[field.key] === 'string' ? (answers[field.key] as string) : ''}
                onChange={(event) =>
                  setAnswer(
                    field.key,
                    field.kind === 'number' ? Number(event.target.value) : event.target.value
                  )
                }
                placeholder={field.kind === 'number' ? '0' : ''}
                className="h-8 rounded-lg border border-border-200 bg-bg-100 px-2.5 text-sm text-text-000 outline-none placeholder:text-text-300 focus-visible:border-ring"
              />
            )}
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onRespond(request.id, 'decline')}
          className="rounded-lg px-2.5 py-1 text-xs text-text-100 transition-colors hover:bg-bg-200 hover:text-text-000"
        >
          {t('ws.elicitationSkip')}
        </button>
        <button
          type="button"
          disabled={missingRequired}
          onClick={submit}
          className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white transition-opacity disabled:opacity-40"
        >
          {t('ws.elicitationSubmit')}
        </button>
      </div>
    </div>
  )
}

export { ElicitationCards }
