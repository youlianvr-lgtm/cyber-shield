import { startTransition, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import { chatDifficulties, recognitionCards, scenarioHints, scenarios } from './data/content'
import { loadProgress, saveProgress } from './lib/storage'
import type {
  ChatApiResponse,
  ChatInsight,
  ChatMessage,
  ChoiceResult,
  ProgressState,
  ScenarioChoice,
  ScenarioStage,
} from './types'

const initialInsight: ChatInsight = {
  redFlags: ['Незнакомый контакт', 'Попытка вызвать срочность', 'Сбор чувствительной информации'],
  coachNote:
    'Живой разбор появится после первого ответа ИИ. Ваша задача — не соглашаться автоматически и не раскрывать реальные данные.',
  riskLevel: 'medium',
  conversationEnded: false,
}

const initialChatMessages = (): ChatMessage[] => [
  {
    id: crypto.randomUUID(),
    role: 'assistant',
    content:
      'Здравствуйте. Я сотрудник службы проверки операций. На вашем аккаунте замечена подозрительная активность. Подтвердите, что это именно вы.',
  },
]

const apiUrl = import.meta.env.VITE_CHAT_API_URL?.trim() ?? ''

const formatRelative = (isoDate: string | null) => {
  if (!isoDate) {
    return 'еще нет активности'
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoDate))
}

const buildMistakeCounts = (
  previous: ProgressState['mistakeTagsCount'],
  tags: string[] | undefined,
) => {
  if (!tags?.length) {
    return previous
  }

  const next = { ...previous }
  tags.forEach((tag) => {
    next[tag] = (next[tag] ?? 0) + 1
  })
  return next
}

const getScenarioById = (scenarioId: string) =>
  scenarios.find((scenario) => scenario.id === scenarioId) ?? scenarios[0]

const isChatApiResponse = (value: unknown): value is ChatApiResponse => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const response = value as Partial<ChatApiResponse>
  return (
    typeof response.assistantReply === 'string' &&
    Array.isArray(response.redFlags) &&
    typeof response.coachNote === 'string' &&
    typeof response.riskLevel === 'string' &&
    typeof response.conversationEnded === 'boolean'
  )
}

function App() {
  const [progress, setProgress] = useState<ProgressState>(() => loadProgress())
  const [activeScenarioId, setActiveScenarioId] = useState(scenarios[0].id)
  const [currentStageId, setCurrentStageId] = useState<string | null>(scenarios[0].stages[0].id)
  const [choiceResults, setChoiceResults] = useState<ChoiceResult[]>([])
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => initialChatMessages())
  const [chatInput, setChatInput] = useState('')
  const [chatInsight, setChatInsight] = useState<ChatInsight>(initialInsight)
  const [chatDifficulty, setChatDifficulty] = useState(chatDifficulties[1])
  const [chatScenarioHint, setChatScenarioHint] = useState(scenarioHints[0])
  const [chatSessionId, setChatSessionId] = useState(() => crypto.randomUUID())
  const [chatError, setChatError] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [chatSessionCounted, setChatSessionCounted] = useState(false)

  useEffect(() => {
    saveProgress(progress)
  }, [progress])

  const selectedScenario = getScenarioById(activeScenarioId)
  const scenarioCompleted = currentStageId === null
  const safeChoices = choiceResults.filter((item) => item.outcome === 'safe').length
  const currentRunScore = choiceResults.length
    ? Math.round((safeChoices / choiceResults.length) * 100)
    : 0
  const topMistakes = Object.entries(progress.mistakeTagsCount)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)

  const scenarioTimeline = selectedScenario.stages
    .map((stage) => ({
      stage,
      result: choiceResults.find((item) => item.stageId === stage.id),
    }))
    .filter(({ stage, result }) => stage.id === currentStageId || result)

  const chooseScenario = (scenarioId: string) => {
    const scenario = getScenarioById(scenarioId)
    startTransition(() => {
      setActiveScenarioId(scenario.id)
      setCurrentStageId(scenario.stages[0].id)
      setChoiceResults([])
    })
  }

  const registerProgressUpdate = (choice: ScenarioChoice, finished: boolean) => {
    setProgress((previous) => {
      const completedScenarioIds =
        finished && !previous.completedScenarioIds.includes(selectedScenario.id)
          ? [...previous.completedScenarioIds, selectedScenario.id]
          : previous.completedScenarioIds

      return {
        completedScenarioIds,
        chatSessionsCount: previous.chatSessionsCount,
        mistakeTagsCount: buildMistakeCounts(previous.mistakeTagsCount, choice.mistakeTags),
        lastVisitedAt: new Date().toISOString(),
      }
    })
  }

  const handleChoice = (stage: ScenarioStage, choice: ScenarioChoice) => {
    if (choiceResults.some((item) => item.stageId === stage.id)) {
      return
    }

    const result: ChoiceResult = {
      stageId: stage.id,
      choiceId: choice.id,
      outcome: choice.outcome,
      explanation: choice.explanation,
      coachTip: choice.coachTip,
    }
    const finished = !choice.nextStageId

    startTransition(() => {
      setChoiceResults((previous) => [...previous, result])
      setCurrentStageId(choice.nextStageId ?? null)
    })

    registerProgressUpdate(choice, finished)
  }

  const resetScenario = () => {
    startTransition(() => {
      setChoiceResults([])
      setCurrentStageId(selectedScenario.stages[0].id)
    })
  }

  const resetChat = () => {
    setChatMessages(initialChatMessages())
    setChatInsight(initialInsight)
    setChatInput('')
    setChatError('')
    setIsSending(false)
    setChatSessionCounted(false)
    setChatSessionId(crypto.randomUUID())
  }

  const handleChatSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isSending) {
      return
    }

    const trimmed = chatInput.trim()
    if (!trimmed) {
      return
    }

    if (!apiUrl) {
      setChatError(
        'Живой ИИ-чат пока не подключен. Укажите VITE_CHAT_API_URL и откройте страницу заново.',
      )
      return
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
    }
    const requestHistory = [...chatMessages, userMessage]

    setChatMessages(requestHistory)
    setChatInput('')
    setChatError('')
    setIsSending(true)

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: chatSessionId,
          history: chatMessages,
          difficulty: chatDifficulty,
          scenarioHint: chatScenarioHint,
          userMessage: trimmed,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data: unknown = await response.json()
      if (!isChatApiResponse(data)) {
        throw new Error('invalid-payload')
      }

      setChatMessages((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.assistantReply,
        },
      ])
      setChatInsight({
        redFlags: data.redFlags,
        coachNote: data.coachNote,
        riskLevel: data.riskLevel,
        conversationEnded: data.conversationEnded,
      })

      if (!chatSessionCounted) {
        setProgress((previous) => ({
          ...previous,
          chatSessionsCount: previous.chatSessionsCount + 1,
          lastVisitedAt: new Date().toISOString(),
        }))
        setChatSessionCounted(true)
      }
    } catch {
      setChatError(
        'Не удалось получить ответ от прокси. Проверьте Worker, переменную VITE_CHAT_API_URL и ограничения CORS.',
      )
    } finally {
      setIsSending(false)
    }
  }

  const riskTone =
    chatInsight.riskLevel === 'high'
      ? 'Высокий риск'
      : chatInsight.riskLevel === 'medium'
        ? 'Средний риск'
        : 'Низкий риск'

  return (
    <div className="app-shell">
      <header className="hero-panel">
        <nav className="top-nav" aria-label="Навигация по разделам">
          <a href="#overview">О проекте</a>
          <a href="#signals">Сигналы</a>
          <a href="#training">Тренировки</a>
          <a href="#chat">ИИ-чат</a>
          <a href="#progress">Прогресс</a>
        </nav>

        <div className="hero-copy" id="overview">
          <div className="eyebrow">КиберПраво: твой щит в сети</div>
          <h1>Тренажер, который учит видеть мошенника до перевода денег.</h1>
          <p className="hero-lead">
            Не просто советы, а практика: типовые схемы, ветвящиеся тренировки и
            учебный ИИ-собеседник, который пытается вас обмануть и тут же показывает,
            чем выдает себя.
          </p>

          <div className="hero-actions">
            <a className="primary-link" href="#training">
              Начать тренировку
            </a>
            <a className="secondary-link" href="#chat">
              Открыть ИИ-чат
            </a>
          </div>
        </div>

        <aside className="hero-scoreboard" aria-label="Ключевые метрики">
          <div className="metric-card">
            <span>Сценарии</span>
            <strong>{scenarios.length}</strong>
            <small>реалистичных схем мошенничества</small>
          </div>
          <div className="metric-card">
            <span>Пройдено</span>
            <strong>{progress.completedScenarioIds.length}</strong>
            <small>сохранено в браузере пользователя</small>
          </div>
          <div className="metric-card">
            <span>ИИ-сессии</span>
            <strong>{progress.chatSessionsCount}</strong>
            <small>живых тренировок с разбором</small>
          </div>
        </aside>
      </header>

      <main className="content-grid">
        <section className="panel panel-wide" id="signals">
          <div className="section-heading">
            <div>
              <p className="section-label">Как распознать</p>
              <h2>Шесть сигналов, которые повторяются почти в любой схеме</h2>
            </div>
            <p className="section-note">
              Эти признаки встроены и в сценарные тренировки, и в ИИ-чат.
            </p>
          </div>

          <div className="signal-grid">
            {recognitionCards.map((card) => (
              <article className="signal-card" key={card.title}>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
                <span>{card.cue}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="panel panel-wide" id="training">
          <div className="section-heading">
            <div>
              <p className="section-label">Тренировки</p>
              <h2>Проходите сценки так, как если бы они случились с вами сегодня</h2>
            </div>
            <p className="section-note">
              Каждый неверный выбор попадает в личную карту ошибок.
            </p>
          </div>

          <div className="training-layout">
            <aside className="scenario-list">
              {scenarios.map((scenario) => {
                const isActive = scenario.id === selectedScenario.id
                const isCompleted = progress.completedScenarioIds.includes(scenario.id)
                return (
                  <button
                    key={scenario.id}
                    className={`scenario-button${isActive ? ' active' : ''}`}
                    onClick={() => chooseScenario(scenario.id)}
                    type="button"
                  >
                    <span className="scenario-category">{scenario.category}</span>
                    <strong>{scenario.title}</strong>
                    <small>
                      {scenario.difficulty}
                      {isCompleted ? ' · пройдено' : ''}
                    </small>
                  </button>
                )
              })}
            </aside>

            <div className="scenario-workspace">
              <div className="scenario-header">
                <div>
                  <p className="section-label">{selectedScenario.category}</p>
                  <h3>{selectedScenario.title}</h3>
                  <p>{selectedScenario.intro}</p>
                </div>
                <button className="ghost-button" onClick={resetScenario} type="button">
                  Начать заново
                </button>
              </div>

              <div className="timeline">
                {scenarioTimeline.map(({ stage, result }) => (
                  <div className="timeline-entry" key={stage.id}>
                    <div className="message-bubble message-bubble--scammer">
                      <span className="message-role">Мошенник</span>
                      <p>{stage.message}</p>
                    </div>

                    {result ? (
                      <>
                        <div className="message-bubble message-bubble--user">
                          <span className="message-role">Ваш выбор</span>
                          <p>
                            {stage.choices.find((choice) => choice.id === result.choiceId)?.label}
                          </p>
                        </div>

                        <div
                          className={`feedback-card ${
                            result.outcome === 'safe' ? 'feedback-card--safe' : 'feedback-card--risk'
                          }`}
                        >
                          <strong>
                            {result.outcome === 'safe' ? 'Верное решение' : 'Рискованное решение'}
                          </strong>
                          <p>{result.explanation}</p>
                          <span>{result.coachTip}</span>
                        </div>
                      </>
                    ) : (
                      <div className="choice-panel">
                        <p className="choice-prompt">{stage.prompt}</p>
                        <div className="red-flag-row">
                          {stage.redFlags.map((flag) => (
                            <span className="red-flag-pill" key={flag}>
                              {flag}
                            </span>
                          ))}
                        </div>
                        <div className="choice-list">
                          {stage.choices.map((choice) => (
                            <button
                              className="choice-button"
                              key={choice.id}
                              onClick={() => handleChoice(stage, choice)}
                              type="button"
                            >
                              {choice.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {scenarioCompleted ? (
                <div className="scenario-summary">
                  <div>
                    <p className="section-label">Итог сценария</p>
                    <h3>{currentRunScore}% точных решений</h3>
                    <p>{selectedScenario.summary}</p>
                  </div>
                  <div className="summary-tags">
                    {selectedScenario.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="panel panel-chat" id="chat">
          <div className="section-heading">
            <div>
              <p className="section-label">ИИ-чат</p>
              <h2>Слева — мошенник, справа — разбор его тактики</h2>
            </div>
            <p className="section-note">
              Не используйте реальные данные: только учебные ответы и условные примеры.
            </p>
          </div>

          <div className="chat-toolbar">
            <label>
              Сценарий
              <select value={chatScenarioHint} onChange={(event) => setChatScenarioHint(event.target.value)}>
                {scenarioHints.map((hint) => (
                  <option key={hint} value={hint}>
                    {hint}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Сложность
              <select value={chatDifficulty} onChange={(event) => setChatDifficulty(event.target.value)}>
                {chatDifficulties.map((difficulty) => (
                  <option key={difficulty} value={difficulty}>
                    {difficulty}
                  </option>
                ))}
              </select>
            </label>

            <button className="ghost-button" onClick={resetChat} type="button">
              Сбросить диалог
            </button>
          </div>

          {!apiUrl ? (
            <div className="chat-banner">
              Укажите <code>VITE_CHAT_API_URL</code>, чтобы включить живой чат через Cloudflare Worker.
            </div>
          ) : null}

          {chatError ? <div className="chat-banner chat-banner--error">{chatError}</div> : null}

          <div className="chat-layout">
            <div className="chat-thread" aria-live="polite">
              {chatMessages.map((message) => (
                <div
                  className={`chat-bubble ${
                    message.role === 'assistant' ? 'chat-bubble--assistant' : 'chat-bubble--user'
                  }`}
                  key={message.id}
                >
                  <span>{message.role === 'assistant' ? 'Мошенник' : 'Вы'}</span>
                  <p>{message.content}</p>
                </div>
              ))}

              {isSending ? <div className="chat-thinking">ИИ анализирует ваш ответ…</div> : null}
            </div>

            <aside className="coach-panel">
              <div className="coach-risk">
                <span>Уровень риска</span>
                <strong>{riskTone}</strong>
              </div>

              <div className="coach-section">
                <h3>Что выдает мошенника</h3>
                <div className="red-flag-row">
                  {chatInsight.redFlags.map((flag) => (
                    <span className="red-flag-pill" key={flag}>
                      {flag}
                    </span>
                  ))}
                </div>
              </div>

              <div className="coach-section">
                <h3>Разбор</h3>
                <p>{chatInsight.coachNote}</p>
              </div>

              {chatInsight.conversationEnded ? (
                <div className="chat-banner">
                  Учебная сцена завершена. Сбросьте диалог или выберите другой сценарий.
                </div>
              ) : null}
            </aside>
          </div>

          <form className="chat-form" onSubmit={handleChatSubmit}>
            <textarea
              rows={3}
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Напишите, как бы вы ответили. Не вводите реальные коды, номера карт и персональные данные."
            />
            <button className="primary-button" disabled={isSending || chatInsight.conversationEnded} type="submit">
              Отправить
            </button>
          </form>
        </section>

        <section className="panel" id="progress">
          <div className="section-heading">
            <div>
              <p className="section-label">Мой прогресс</p>
              <h2>Куда смотреть после тренировки</h2>
            </div>
            <p className="section-note">Сохраняется локально, без аккаунта.</p>
          </div>

          <div className="progress-grid">
            <article className="progress-card">
              <span>Завершено сценариев</span>
              <strong>{progress.completedScenarioIds.length}</strong>
              <p>Из {scenarios.length} доступных тренировок.</p>
            </article>

            <article className="progress-card">
              <span>ИИ-сессии</span>
              <strong>{progress.chatSessionsCount}</strong>
              <p>Живых учебных диалогов с разбором.</p>
            </article>

            <article className="progress-card">
              <span>Последняя активность</span>
              <strong>{formatRelative(progress.lastVisitedAt)}</strong>
              <p>Любой выбор или успешный ответ чата обновляет метку.</p>
            </article>
          </div>

          <div className="mistake-board">
            <div>
              <p className="section-label">Повторяющиеся ошибки</p>
              <h3>Личная карта уязвимостей</h3>
            </div>

            {topMistakes.length ? (
              <div className="mistake-list">
                {topMistakes.map(([tag, count]) => (
                  <div className="mistake-item" key={tag}>
                    <span>{tag}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                Ошибок пока нет. Пройдите хотя бы один сценарий и карта начнет заполняться.
              </div>
            )}
          </div>
        </section>

        <section className="panel panel-wide panel-footer">
          <div>
            <p className="section-label">Для конкурса</p>
            <h2>Почему проект полезен</h2>
          </div>
          <p>
            Вместо пассивного чтения пользователь тренируется на типовых атаках, видит свои
            слабые места и получает понятный разбор прямо в момент ошибки. Это делает тему
            цифровой безопасности конкретной и запоминающейся.
          </p>
        </section>
      </main>
    </div>
  )
}

export default App
