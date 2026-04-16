import { startTransition, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import './App.css'
import {
  chatDifficulties,
  recognitionCards,
  safetyQuotes,
  scenarioHints,
  scenarios,
} from './data/content'
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

type MainTab = 'learn' | 'chat' | 'cases' | 'progress'
type ChatTab = 'dialog' | 'coach'

const initialInsight: ChatInsight = {
  redFlags: ['Неожиданный контакт', 'Давление срочностью', 'Запрос чувствительных данных'],
  coachNote: 'После ответа появится разбор и уязвимости в вашей формулировке.',
  riskLevel: 'medium',
  conversationEnded: false,
  userVerdict: 'Оценка появится после вашей первой реплики.',
  userWasSafe: null,
  mistakeTag: null,
  simulatedCode: null,
}

const initialChatMessages = (): ChatMessage[] => [
  {
    id: crypto.randomUUID(),
    role: 'assistant',
    content:
      'Здравствуйте. По вашей карте зафиксирована подозрительная операция. Подтвердите отмену прямо сейчас.',
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

const normalizeMessage = (message: string) => message.toLowerCase().replace(/\s+/g, ' ').trim()

const safeReplyPatterns = [
  /не\s+(буду|стану|собираюсь)\s+(говорить|диктовать|сообщать|называть|отправлять|вводить)/i,
  /не\s+(скажу|назову|сообщу|продиктую|отправлю|введу)/i,
  /сам\s+(перезвоню|позвоню|проверю)/i,
  /проверю\s+(в|через|по)/i,
  /не\s+перейду\s+по\s+ссылке/i,
  /не\s+буду\s+переводить/i,
  /заверш(у|ить)\s+(звонок|разговор|диалог)/i,
  /прекращ(аю|у)\s+(разговор|общение)/i,
  /блокирую\s+(номер|контакт)/i,
  /отказываюсь/i,
  /откажусь/i,
]

const negatedRiskPatterns = [
  /не\s+(скажу|назову|сообщу|продиктую|отправлю|введу)/i,
  /не\s+(переведу|перевожу|буду\s+переводить)/i,
  /не\s+(перейду|открою)\s+(по\s+)?(ссылке|сайт)/i,
  /не\s+(подтвержу|выполню|продолжу)/i,
]

const riskyReplyPatterns = [
  {
    pattern: /(скажу|назову|сообщу|продиктую|отправлю|введу).{0,28}(код|смс|парол|данн)/i,
    mistakeTag: 'код-подтверждения',
  },
  {
    pattern: /(переведу|перевожу|отправлю).{0,28}(деньг|сумм|оплат)/i,
    mistakeTag: 'перевод-денег',
  },
  {
    pattern: /(перейду|открою).{0,24}(ссылк|сайт)/i,
    mistakeTag: 'переход-по-ссылке',
  },
  {
    pattern: /(сообщу|скажу|отправлю|введу).{0,24}(карт|cvv|паспорт|данн)/i,
    mistakeTag: 'передача-данных',
  },
  {
    pattern: /(подтвержу|выполню|продолжу).{0,28}(операц|шаг|инструкц)/i,
    mistakeTag: 'доверие-сценарию',
  },
]

const evaluateReplyLocally = (message: string) => {
  const normalizedMessage = normalizeMessage(message)

  if (!normalizedMessage) {
    return null
  }

  if (safeReplyPatterns.some((pattern) => pattern.test(normalizedMessage))) {
    return {
      userWasSafe: true,
      userVerdict:
        'Безопасная реакция: вы не приняли правила мошенника и перевели проверку в независимый канал.',
      mistakeTag: null,
    }
  }

  if (negatedRiskPatterns.some((pattern) => pattern.test(normalizedMessage))) {
    return {
      userWasSafe: true,
      userVerdict:
        'Ответ выглядит осторожным: вы отказываетесь от рискованных действий и сохраняете контроль над ситуацией.',
      mistakeTag: null,
    }
  }

  const riskyMatch = riskyReplyPatterns.find(({ pattern }) => pattern.test(normalizedMessage))
  if (riskyMatch) {
    return {
      userWasSafe: false,
      userVerdict:
        'Рискованный ответ: вы начинаете действовать по сценарию мошенника вместо независимой проверки.',
      mistakeTag: riskyMatch.mistakeTag,
    }
  }

  return null
}

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
    typeof response.conversationEnded === 'boolean' &&
    typeof response.userVerdict === 'string' &&
    (typeof response.userWasSafe === 'boolean' || response.userWasSafe === null) &&
    (typeof response.mistakeTag === 'string' || response.mistakeTag === null) &&
    (typeof response.simulatedCode === 'string' || response.simulatedCode === null)
  )
}

const useMediaQuery = (query: string) => {
  const getMatches = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }

    return window.matchMedia(query).matches
  }

  const [matches, setMatches] = useState(getMatches)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }

    const mediaQueryList = window.matchMedia(query)
    const onChange = () => setMatches(mediaQueryList.matches)

    onChange()

    if (typeof mediaQueryList.addEventListener === 'function') {
      mediaQueryList.addEventListener('change', onChange)
      return () => mediaQueryList.removeEventListener('change', onChange)
    }

    mediaQueryList.addListener(onChange)
    return () => mediaQueryList.removeListener(onChange)
  }, [query])

  return matches
}

const normalizeHash = (hash: string) => hash.replace(/^#/, '').trim().toLowerCase()

function App() {
  const [progress, setProgress] = useState<ProgressState>(() => loadProgress())
  const [scenarioModalOpen, setScenarioModalOpen] = useState(false)
  const [scenarioModalScenarioId, setScenarioModalScenarioId] = useState(scenarios[0].id)
  const [scenarioStageId, setScenarioStageId] = useState<string | null>(scenarios[0].stages[0].id)
  const [scenarioChoiceResults, setScenarioChoiceResults] = useState<ChoiceResult[]>([])
  const [scenarioReviewExpanded, setScenarioReviewExpanded] = useState(true)
  const [lockedScenarioNotice, setLockedScenarioNotice] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => initialChatMessages())
  const [chatInput, setChatInput] = useState('')
  const [chatInsight, setChatInsight] = useState<ChatInsight>(initialInsight)
  const [chatDifficulty, setChatDifficulty] = useState(chatDifficulties[1])
  const [chatScenarioHint, setChatScenarioHint] = useState(scenarioHints[0])
  const [chatSessionId, setChatSessionId] = useState(() => crypto.randomUUID())
  const [chatError, setChatError] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [chatSessionCounted, setChatSessionCounted] = useState(false)
  const [mainTab, setMainTab] = useState<MainTab>('learn')
  const [chatTab, setChatTab] = useState<ChatTab>('dialog')
  const isMobile = useMediaQuery('(max-width: 719px)')

  useEffect(() => {
    saveProgress(progress)
  }, [progress])

  useEffect(() => {
    if (!isMobile) {
      return
    }

    const normalized = normalizeHash(window.location.hash)
    if (!normalized) {
      return
    }

    if (normalized === 'chat') {
      setMainTab('chat')
    } else if (normalized === 'cases') {
      setMainTab('cases')
    } else if (normalized === 'progress') {
      setMainTab('progress')
    } else if (normalized === 'signals' || normalized === 'tips' || normalized === 'overview') {
      setMainTab('learn')
    }
  }, [isMobile])

  const firstUncompletedScenarioIndex = scenarios.findIndex(
    (scenario) => !progress.completedScenarioIds.includes(scenario.id),
  )
  const currentScenarioIndex =
    firstUncompletedScenarioIndex === -1 ? scenarios.length - 1 : firstUncompletedScenarioIndex

  const modalScenario = getScenarioById(scenarioModalScenarioId)
  const modalScenarioIndex = scenarios.findIndex((scenario) => scenario.id === modalScenario.id)
  const modalScenarioCompleted = progress.completedScenarioIds.includes(modalScenario.id)
  const scenarioFinished = scenarioStageId === null
  const safeChoices = scenarioChoiceResults.filter((item) => item.outcome === 'safe').length
  const currentRunScore = scenarioChoiceResults.length
    ? Math.round((safeChoices / scenarioChoiceResults.length) * 100)
    : 0
  const topMistakes = Object.entries(progress.mistakeTagsCount)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)

  const scenarioTimeline = modalScenario.stages
    .map((stage) => ({
      stage,
      result: scenarioChoiceResults.find((item) => item.stageId === stage.id),
    }))
    .filter(({ stage, result }) => stage.id === scenarioStageId || result)

  const openScenarioModal = (scenarioId: string) => {
    const scenario = getScenarioById(scenarioId)
    startTransition(() => {
      setScenarioModalScenarioId(scenario.id)
      setScenarioStageId(scenario.stages[0].id)
      setScenarioChoiceResults([])
      setScenarioReviewExpanded(true)
      setScenarioModalOpen(true)
    })
  }

  const registerProgressUpdate = (scenarioId: string, choice: ScenarioChoice, finished: boolean) => {
    setProgress((previous) => {
      const completedScenarioIds =
        finished && !previous.completedScenarioIds.includes(scenarioId)
          ? [...previous.completedScenarioIds, scenarioId]
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
    if (scenarioChoiceResults.some((item) => item.stageId === stage.id)) {
      return
    }

    const result: ChoiceResult = {
      stageId: stage.id,
      choiceId: choice.id,
      outcome: choice.outcome,
      explanation: choice.explanation,
      coachTip: choice.coachTip,
    }

    startTransition(() => {
      setScenarioChoiceResults((previous) => [...previous, result])
      setScenarioStageId(choice.nextStageId ?? null)
      if (!choice.nextStageId) {
        setScenarioReviewExpanded(false)
      }
    })

    registerProgressUpdate(modalScenario.id, choice, !choice.nextStageId)
  }

  const resetScenarioRun = () => {
    startTransition(() => {
      setScenarioChoiceResults([])
      setScenarioStageId(modalScenario.stages[0].id)
      setScenarioReviewExpanded(true)
    })
  }

  const openNextScenario = () => {
    if (modalScenarioIndex === scenarios.length - 1) {
      setScenarioModalOpen(false)
      if (isMobile) {
        setMainTab('progress')
        if (typeof window !== 'undefined' && typeof window.history?.replaceState === 'function') {
          window.history.replaceState(null, '', '#progress')
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }
        return
      }

      if (typeof window !== 'undefined') {
        window.location.hash = '#progress'
        document.querySelector('#progress')?.scrollIntoView({ behavior: 'smooth' })
      }
      return
    }

    const isRetake = modalScenarioIndex < currentScenarioIndex
    const nextIndex = isRetake
      ? currentScenarioIndex
      : Math.min(currentScenarioIndex + 1, scenarios.length - 1)
    openScenarioModal(scenarios[nextIndex].id)
  }

  const handleScenarioModalOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      const hasStarted = scenarioStageId !== null && scenarioChoiceResults.length > 0
      if (hasStarted && !scenarioFinished) {
        const confirmed = window.confirm('Тест не завершен. Закрыть и потерять прогресс?')
        if (!confirmed) {
          return
        }
      }
    }

    setScenarioModalOpen(nextOpen)
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
      setChatError('Живой диалог пока не подключен. Укажите VITE_CHAT_API_URL и обновите страницу.')
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
          history: requestHistory,
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

      const localEvaluation = evaluateReplyLocally(trimmed)
      const resolvedUserWasSafe = localEvaluation?.userWasSafe ?? data.userWasSafe
      const resolvedMistakeTag = localEvaluation?.mistakeTag ?? data.mistakeTag
      const resolvedUserVerdict =
        localEvaluation?.userVerdict ??
        (resolvedUserWasSafe === null
          ? 'Ответ принят. Для точной оценки укажите, что именно вы делаете: отказываетесь, проверяете источник или соглашаетесь.'
          : data.userVerdict)

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
        userVerdict: resolvedUserVerdict,
        userWasSafe: resolvedUserWasSafe,
        mistakeTag: resolvedMistakeTag,
        simulatedCode: data.simulatedCode,
      })

      setProgress((previous) => ({
        ...previous,
        chatSessionsCount: previous.chatSessionsCount + (chatSessionCounted ? 0 : 1),
        mistakeTagsCount:
          resolvedUserWasSafe !== false || !resolvedMistakeTag
            ? previous.mistakeTagsCount
            : buildMistakeCounts(previous.mistakeTagsCount, [resolvedMistakeTag]),
        lastVisitedAt: new Date().toISOString(),
      }))

      if (!chatSessionCounted) {
        setChatSessionCounted(true)
      }
    } catch {
      setChatError(
        'Не удалось получить ответ от прокси. Проверьте Worker, VITE_CHAT_API_URL и настройки CORS.',
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

  const verdictTone =
    chatInsight.userWasSafe === null
      ? 'verdict-card'
      : chatInsight.userWasSafe
        ? 'verdict-card verdict-card--safe'
        : 'verdict-card verdict-card--risk'

  const setMobileTab = (nextTab: MainTab) => {
    setMainTab(nextTab)

    if (typeof window !== 'undefined' && typeof window.history?.replaceState === 'function') {
      const nextHash = nextTab === 'learn' ? '#signals' : `#${nextTab}`
      window.history.replaceState(null, '', nextHash)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const renderMobileChatCoach = () => (
    <aside className="coach-panel coach-panel--mobile">
      <div className="coach-risk">
        <span>Уровень риска</span>
        <strong>{riskTone}</strong>
      </div>

      <div className="coach-section">
        <h3>Красные флаги</h3>
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

      <div className="coach-section">
        <h3>Оценка реакции</h3>
        <div className={verdictTone}>
          <strong>
            {chatInsight.userWasSafe === null
              ? 'Нужна более точная формулировка'
              : chatInsight.userWasSafe
                ? 'Реакция безопасная'
                : 'Реакция рискованная'}
          </strong>
          <p>{chatInsight.userVerdict}</p>
        </div>
      </div>

      {chatInsight.simulatedCode ? (
        <div className="coach-section">
          <h3>Учебный код</h3>
          <div className="code-card">
            <span>Пример кода, который могут пытаться выманить</span>
            <strong>{chatInsight.simulatedCode}</strong>
          </div>
        </div>
      ) : null}

      {chatInsight.conversationEnded ? (
        <div className="chat-banner">Сцена завершена. Начните новый диалог или смените сценарий.</div>
      ) : null}
    </aside>
  )

  const renderMobileChat = () => (
    <section className="panel panel-chat panel-chat--mobile" id="chat">
      <div className="section-heading">
        <div>
          <p className="section-label">Практика</p>
          <h2>Тренажер диалога</h2>
        </div>
        <p className="section-note">Только учебные ответы. Без реальных кодов и данных.</p>
      </div>

      <div className="segmented" role="tablist" aria-label="Режим тренажера">
        <button
          className={chatTab === 'dialog' ? 'active' : ''}
          onClick={() => setChatTab('dialog')}
          type="button"
          role="tab"
          aria-selected={chatTab === 'dialog'}
        >
          Диалог
        </button>
        <button
          className={chatTab === 'coach' ? 'active' : ''}
          onClick={() => setChatTab('coach')}
          type="button"
          role="tab"
          aria-selected={chatTab === 'coach'}
        >
          Разбор
        </button>
      </div>

      {!apiUrl ? (
        <div className="chat-banner">
          Укажите <code>VITE_CHAT_API_URL</code>, чтобы включить живой диалог через Cloudflare Worker.
        </div>
      ) : null}

      {chatError ? <div className="chat-banner chat-banner--error">{chatError}</div> : null}

      {chatTab === 'coach' ? (
        <>
          <div className="chat-toolbar chat-toolbar--mobile">
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
              Начать заново
            </button>
          </div>

          {renderMobileChatCoach()}
        </>
      ) : (
        <>
          <div className="chat-thread chat-thread--mobile" aria-live="polite">
            {chatMessages.map((message) => (
              <div
                className={`chat-bubble ${
                  message.role === 'assistant' ? 'chat-bubble--assistant' : 'chat-bubble--user'
                }`}
                key={message.id}
              >
                <span>{message.role === 'assistant' ? 'Собеседник' : 'Вы'}</span>
                <p>{message.content}</p>
              </div>
            ))}

            {isSending ? <div className="chat-thinking">Ответ обрабатывается…</div> : null}
          </div>

          <form className="chat-form chat-form--mobile" onSubmit={handleChatSubmit}>
            <textarea
              rows={2}
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Например: Я завершаю разговор и перезваниваю в банк по официальному номеру."
            />
            <div className="chat-form-actions">
              <button className="ghost-button" onClick={resetChat} type="button">
                Сброс
              </button>
              <button className="primary-button" disabled={isSending || chatInsight.conversationEnded} type="submit">
                Отправить
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  )

  const renderScenarioModal = () => (
    <Dialog.Root open={scenarioModalOpen} onOpenChange={handleScenarioModalOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content" aria-label={`Тест: ${modalScenario.title}`}>
          <div className="modal-header">
            <div>
              <p className="section-label">
                Тест {modalScenarioIndex + 1} из {scenarios.length}
                {modalScenarioCompleted ? ' · пройден' : ''}
              </p>
              <h3>{modalScenario.title}</h3>
              <p className="modal-intro">{modalScenario.intro}</p>
            </div>
            <Dialog.Close asChild>
              <button className="icon-button" type="button" aria-label="Закрыть окно">
                <span aria-hidden="true">×</span>
              </button>
            </Dialog.Close>
          </div>

          <div className="modal-body">
            {!scenarioFinished || scenarioReviewExpanded ? (
              <div className="timeline">
                {scenarioTimeline.map(({ stage, result }) => (
                  <div className="timeline-entry" key={stage.id}>
                    <div className="message-bubble message-bubble--scammer">
                      <span className="message-role">Собеседник</span>
                      <p>{stage.message}</p>
                    </div>

                    {result ? (
                      <>
                        <div className="message-bubble message-bubble--user">
                          <span className="message-role">Ваш ответ</span>
                          <p>{stage.choices.find((choice) => choice.id === result.choiceId)?.label}</p>
                        </div>

                        <div
                          className={`feedback-card ${
                            result.outcome === 'safe' ? 'feedback-card--safe' : 'feedback-card--risk'
                          }`}
                        >
                          <strong>{result.outcome === 'safe' ? 'Безопасное решение' : 'Рискованное решение'}</strong>
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
            ) : null}

            {scenarioFinished ? (
              <div className="scenario-summary scenario-summary--modal">
                <div>
                  <p className="section-label">Итог</p>
                  <h3>{currentRunScore}% безопасных решений</h3>
                  <p>{modalScenario.summary}</p>
                </div>
                <div className="summary-tags">
                  {modalScenario.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </div>
            ) : null}

            {scenarioFinished ? (
              <div className="modal-actions">
                <button
                  className="ghost-button"
                  onClick={() => setScenarioReviewExpanded((previous) => !previous)}
                  type="button"
                >
                  {scenarioReviewExpanded ? 'Скрыть разбор' : 'Показать разбор'}
                </button>
              </div>
            ) : null}
          </div>

          {scenarioFinished ? (
            <div className="modal-footer">
              <button className="ghost-button" onClick={resetScenarioRun} type="button">
                Пройти заново
              </button>
              <button className="primary-button" onClick={openNextScenario} type="button">
                {modalScenarioIndex === scenarios.length - 1 ? 'К итогам' : 'Пройти следующий тест'}
              </button>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )

  if (isMobile) {
    return (
      <div className="app-shell app-shell--mobile">
        <header className="mobile-header" id="overview">
          <div className="brand">
            <img className="brand-mark" src="/logo.svg" alt="" aria-hidden="true" />
            <span className="brand-name">Мошенник.NET</span>
          </div>
          <h1 className="mobile-title">Тренируйтесь распознавать мошеннические сценарии.</h1>
          <div className="mobile-metrics" aria-label="Ключевые метрики">
            <div className="mini-metric">
              <span>Сценарии</span>
              <strong>{scenarios.length}</strong>
            </div>
            <div className="mini-metric">
              <span>Изучено</span>
              <strong>{progress.completedScenarioIds.length}</strong>
            </div>
            <div className="mini-metric">
              <span>Диалоги</span>
              <strong>{progress.chatSessionsCount}</strong>
            </div>
          </div>
        </header>

        <main className="tabview" aria-label="Контент">
          {mainTab === 'learn' ? (
            <div className="tabpage">
              <section className="panel panel-wide" id="signals">
                <div className="section-heading">
                  <div>
                    <p className="section-label">База распознавания</p>
                    <h2>Сигналы риска</h2>
                  </div>
                  <p className="section-note">Карточки-маркеры и формулировки для проверки.</p>
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

              <section className="panel" id="tips">
                <div className="section-heading">
                  <div>
                    <p className="section-label">Советы</p>
                    <h2>Короткие формулировки</h2>
                  </div>
                  <p className="section-note">Без интерпретаций: только прямые рекомендации.</p>
                </div>
                <div className="quotes-grid">
                  {safetyQuotes.map((quote) => (
                    <blockquote className="quote-card" key={quote}>
                      {quote}
                    </blockquote>
                  ))}
                </div>
              </section>
            </div>
          ) : null}

          {mainTab === 'chat' ? <div className="tabpage">{renderMobileChat()}</div> : null}

          {mainTab === 'cases' ? (
            <div className="tabpage">
              <section className="panel panel-wide" id="cases">
                <div className="section-heading">
                  <div>
                    <p className="section-label">Сценарии</p>
                    <h2>Тренировка на примерах</h2>
                  </div>
                  <p className="section-note">Выбирайте вариант ответа и смотрите последствия.</p>
                </div>

                {lockedScenarioNotice ? (
                  <div className="chat-banner chat-banner--compact" role="status">
                    {lockedScenarioNotice}
                  </div>
                ) : null}

                <div className="scenario-list scenario-list--tests" aria-label="Список тестов">
                  {scenarios.map((scenario, index) => {
                    const isCompleted = progress.completedScenarioIds.includes(scenario.id)
                    const isCurrent = index === currentScenarioIndex
                    const isAvailable = index <= currentScenarioIndex
                    const statusLabel = isCompleted ? 'Пройден' : isCurrent ? 'Текущий' : 'Заблокирован'
                    const statusTone = isCompleted ? 'done' : isCurrent ? 'current' : 'locked'
                    const isSelected = scenarioModalOpen ? scenario.id === modalScenario.id : isCurrent

                    const handleLockedAttempt = () => {
                      if (isAvailable) {
                        return
                      }

                      setLockedScenarioNotice('Завершите предыдущий тест, чтобы открыть этот.')
                      window.setTimeout(() => setLockedScenarioNotice(''), 2400)
                    }

                    return (
                      <div className="scenario-item" key={scenario.id} onClick={handleLockedAttempt}>
                        <button
                          className={`scenario-button scenario-button--test${isSelected ? ' active' : ''}`}
                          onClick={isAvailable ? () => openScenarioModal(scenario.id) : undefined}
                          type="button"
                          disabled={!isAvailable}
                        >
                          <span className="scenario-index">{index + 1}</span>
                          <span className="scenario-main">
                            <strong>{scenario.title}</strong>
                            <small>{scenario.difficulty}</small>
                          </span>
                          <span className={`scenario-status scenario-status--${statusTone}`}>{statusLabel}</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            </div>
          ) : null}

          {mainTab === 'progress' ? (
            <div className="tabpage">
              <section className="panel" id="progress">
                <div className="section-heading">
                  <div>
                    <p className="section-label">Ваш прогресс</p>
                    <h2>Личная статистика</h2>
                  </div>
                  <p className="section-note">Данные сохраняются только в вашем браузере.</p>
                </div>

                <div className="progress-grid">
                  <article className="progress-card">
                    <span>Разобрано ситуаций</span>
                    <strong>{progress.completedScenarioIds.length}</strong>
                    <p>Из {scenarios.length} доступных сценариев.</p>
                  </article>

                  <article className="progress-card">
                    <span>Диалоги</span>
                    <strong>{progress.chatSessionsCount}</strong>
                    <p>Тренировочных сессий с обратной связью.</p>
                  </article>

                  <article className="progress-card">
                    <span>Последняя активность</span>
                    <strong>{formatRelative(progress.lastVisitedAt)}</strong>
                    <p>Обновляется после выбора в сценариях и ответов в диалоге.</p>
                  </article>
                </div>

                <div className="mistake-board">
                  <div>
                    <p className="section-label">Карта уязвимостей</p>
                    <h3>Повторяющиеся ошибки</h3>
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
                      Ошибок пока нет. Пройдите сценарий или диалог, чтобы увидеть персональную статистику.
                    </div>
                  )}
                </div>
              </section>
            </div>
          ) : null}
        </main>

        <nav className="tabbar" aria-label="Разделы">
          <button
            className={mainTab === 'learn' ? 'active' : ''}
            onClick={() => setMobileTab('learn')}
            type="button"
            aria-current={mainTab === 'learn' ? 'page' : undefined}
          >
            База
          </button>
          <button
            className={mainTab === 'chat' ? 'active' : ''}
            onClick={() => setMobileTab('chat')}
            type="button"
            aria-current={mainTab === 'chat' ? 'page' : undefined}
          >
            Чат
          </button>
          <button
            className={mainTab === 'cases' ? 'active' : ''}
            onClick={() => setMobileTab('cases')}
            type="button"
            aria-current={mainTab === 'cases' ? 'page' : undefined}
          >
            Сценарии
          </button>
          <button
            className={mainTab === 'progress' ? 'active' : ''}
            onClick={() => setMobileTab('progress')}
            type="button"
            aria-current={mainTab === 'progress' ? 'page' : undefined}
          >
            Прогресс
          </button>
        </nav>

        {renderScenarioModal()}
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="hero-panel" id="overview">
        <nav className="top-nav" aria-label="Навигация по разделам">
          <a href="#signals">Признаки</a>
          <a href="#chat">Тренажер</a>
          <a href="#cases">Сценарии</a>
          <a href="#tips">Советы</a>
          <a href="#progress">Прогресс</a>
        </nav>

        <div className="hero-copy">
          <div className="brand">
            <img className="brand-mark" src="/logo.svg" alt="" aria-hidden="true" />
            <span className="brand-name">Мошенник.NET</span>
          </div>
          <h1>Распознавайте схему до того, как от вас попросят данные или деньги.</h1>
          <p className="hero-lead">
            Практический тренажер: сигналы риска, диалог с имитацией давления, сценарии с разбором ошибок.
          </p>

          <div className="hero-actions">
            <a className="primary-link" href="#signals">
              Начать обучение
            </a>
            <a className="secondary-link" href="#chat">
              Открыть тренажер
            </a>
          </div>
        </div>

        <aside className="hero-scoreboard" aria-label="Ключевые метрики">
          <div className="metric-card">
            <span>Сценарии</span>
            <strong>{scenarios.length}</strong>
            <small>типовых мошеннических схем</small>
          </div>
          <div className="metric-card">
            <span>Изучено</span>
            <strong>{progress.completedScenarioIds.length}</strong>
            <small>сценариев завершено</small>
          </div>
          <div className="metric-card">
            <span>Диалоги</span>
            <strong>{progress.chatSessionsCount}</strong>
            <small>тренировочных сессий</small>
          </div>
        </aside>
      </header>

      <main className="content-grid">
        <section className="panel panel-wide" id="signals">
          <div className="section-heading">
            <div>
              <p className="section-label">База распознавания</p>
              <h2>Сигналы, которые чаще всего выдают мошеннический сценарий</h2>
            </div>
            <p className="section-note">Каждая карточка — краткий маркер и практическая формулировка для проверки.</p>
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

        <section className="panel panel-chat" id="chat">
          <div className="section-heading">
            <div>
              <p className="section-label">Практика в диалоге</p>
              <h2>Проверьте формулировки ответа под давлением</h2>
            </div>
            <p className="section-note">Пишите только учебные ответы, без реальных кодов и персональных данных.</p>
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
              Начать заново
            </button>
          </div>

          {!apiUrl ? (
            <div className="chat-banner">
              Укажите <code>VITE_CHAT_API_URL</code>, чтобы включить живой диалог через Cloudflare Worker.
            </div>
          ) : null}

          {chatError ? <div className="chat-banner chat-banner--error">{chatError}</div> : null}

          <div className="chat-layout">
            <aside className="coach-panel">
              <div className="coach-risk">
                <span>Уровень риска</span>
                <strong>{riskTone}</strong>
              </div>

              <div className="coach-section">
                <h3>Красные флаги</h3>
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

              <div className="coach-section">
                <h3>Оценка реакции</h3>
                <div className={verdictTone}>
                  <strong>
                    {chatInsight.userWasSafe === null
                      ? 'Нужна более точная формулировка'
                      : chatInsight.userWasSafe
                        ? 'Реакция безопасная'
                        : 'Реакция рискованная'}
                  </strong>
                  <p>{chatInsight.userVerdict}</p>
                </div>
              </div>

              {chatInsight.simulatedCode ? (
                <div className="coach-section">
                  <h3>Учебный код</h3>
                  <div className="code-card">
                    <span>Пример кода, который могут пытаться выманить</span>
                    <strong>{chatInsight.simulatedCode}</strong>
                  </div>
                </div>
              ) : null}

              {chatInsight.conversationEnded ? (
                <div className="chat-banner">Сцена завершена. Начните новый диалог или смените сценарий.</div>
              ) : null}
            </aside>

            <div className="chat-thread" aria-live="polite">
              {chatMessages.map((message) => (
                <div
                  className={`chat-bubble ${
                    message.role === 'assistant' ? 'chat-bubble--assistant' : 'chat-bubble--user'
                  }`}
                  key={message.id}
                >
                  <span>{message.role === 'assistant' ? 'Собеседник' : 'Вы'}</span>
                  <p>{message.content}</p>
                </div>
              ))}

              {isSending ? <div className="chat-thinking">Ответ обрабатывается…</div> : null}
            </div>
          </div>

          <form className="chat-form" onSubmit={handleChatSubmit}>
            <textarea
              rows={3}
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Например: Я завершаю разговор и перезваниваю в банк по официальному номеру."
            />
            <button className="primary-button" disabled={isSending || chatInsight.conversationEnded} type="submit">
              Отправить
            </button>
          </form>
        </section>

        <section className="panel panel-wide" id="cases">
          <div className="section-heading">
            <div>
              <p className="section-label">Сценарии</p>
              <h2>Тренируйтесь на реалистичных примерах и фиксируйте уязвимости</h2>
            </div>
            <p className="section-note">Каждое рискованное действие попадает в вашу личную карту ошибок.</p>
          </div>

          {lockedScenarioNotice ? (
            <div className="chat-banner chat-banner--compact" role="status">
              {lockedScenarioNotice}
            </div>
          ) : null}

          <div className="scenario-list scenario-list--tests" aria-label="Список тестов">
            {scenarios.map((scenario, index) => {
              const isCompleted = progress.completedScenarioIds.includes(scenario.id)
              const isCurrent = index === currentScenarioIndex
              const isAvailable = index <= currentScenarioIndex
              const statusLabel = isCompleted ? 'Пройден' : isCurrent ? 'Текущий' : 'Заблокирован'
              const statusTone = isCompleted ? 'done' : isCurrent ? 'current' : 'locked'
              const isSelected = scenarioModalOpen ? scenario.id === modalScenario.id : isCurrent

              const handleLockedAttempt = () => {
                if (isAvailable) {
                  return
                }

                setLockedScenarioNotice('Завершите предыдущий тест, чтобы открыть этот.')
                window.setTimeout(() => setLockedScenarioNotice(''), 2400)
              }

              return (
                <div className="scenario-item" key={scenario.id} onClick={handleLockedAttempt}>
                  <button
                    className={`scenario-button scenario-button--test${isSelected ? ' active' : ''}`}
                    onClick={isAvailable ? () => openScenarioModal(scenario.id) : undefined}
                    type="button"
                    disabled={!isAvailable}
                  >
                    <span className="scenario-index">{index + 1}</span>
                    <span className="scenario-main">
                      <strong>{scenario.title}</strong>
                      <small>{scenario.difficulty}</small>
                    </span>
                    <span className={`scenario-status scenario-status--${statusTone}`}>{statusLabel}</span>
                  </button>
                </div>
              )
            })}
          </div>
        </section>

        <section className="panel" id="tips">
          <div className="section-heading">
            <div>
              <p className="section-label">Цитируемые советы</p>
              <h2>Короткая база формулировок, которые стоит держать под рукой</h2>
            </div>
            <p className="section-note">Без интерпретаций: только прямые, знакомые рекомендации по кибергигиене.</p>
          </div>
          <div className="quotes-grid">
            {safetyQuotes.map((quote) => (
              <blockquote className="quote-card" key={quote}>
                {quote}
              </blockquote>
            ))}
          </div>
        </section>

        <section className="panel" id="progress">
          <div className="section-heading">
            <div>
              <p className="section-label">Ваш прогресс</p>
              <h2>Что стоит подтянуть в первую очередь</h2>
            </div>
            <p className="section-note">Данные сохраняются только в вашем браузере.</p>
          </div>

          <div className="progress-grid">
            <article className="progress-card">
              <span>Разобрано ситуаций</span>
              <strong>{progress.completedScenarioIds.length}</strong>
              <p>Из {scenarios.length} доступных сценариев.</p>
            </article>

            <article className="progress-card">
              <span>Диалоги</span>
              <strong>{progress.chatSessionsCount}</strong>
              <p>Тренировочных сессий с обратной связью.</p>
            </article>

            <article className="progress-card">
              <span>Последняя активность</span>
              <strong>{formatRelative(progress.lastVisitedAt)}</strong>
              <p>Обновляется после выбора в сценариях и ответов в диалоге.</p>
            </article>
          </div>

          <div className="mistake-board">
            <div>
              <p className="section-label">Карта уязвимостей</p>
              <h3>Повторяющиеся ошибки</h3>
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
                Ошибок пока нет. Пройдите сценарий или диалог, чтобы увидеть персональную статистику.
              </div>
            )}
          </div>
        </section>
      </main>

      {renderScenarioModal()}
    </div>
  )
}

export default App
