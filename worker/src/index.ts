type Env = {
  GROQ_API_KEY: string
  ALLOWED_ORIGIN: string
  GROQ_MODEL?: string
}

type ChatMessage = {
  role: 'assistant' | 'user'
  content: string
}

type ChatRequest = {
  sessionId: string
  history: ChatMessage[]
  difficulty: string
  scenarioHint: string
  userMessage: string
}

type ChatResponse = {
  assistantReply: string
  redFlags: string[]
  coachNote: string
  riskLevel: 'low' | 'medium' | 'high'
  conversationEnded: boolean
  userVerdict: string
  userWasSafe: boolean | null
  mistakeTag: string | null
  asksForCode: boolean
}

type UserReplyEvaluation = {
  userWasSafe: boolean
  userVerdict: string
  mistakeTag: string | null
}

const json = (data: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  })

const buildCorsHeaders = (origin: string | null, allowedOrigin: string) => {
  const allowOrigin = origin && isAllowedOrigin(origin, allowedOrigin) ? origin : allowedOrigin

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    Vary: 'Origin',
  }
}

const isAllowedOrigin = (origin: string, allowedOrigin: string) => {
  if (origin === allowedOrigin) {
    return true
  }

  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
}

const sanitizeHistory = (history: ChatMessage[]) =>
  history
    .filter(
      (message): message is ChatMessage =>
        (message.role === 'assistant' || message.role === 'user') &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0,
    )
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 900),
    }))

const generateTrainingCode = () =>
  Math.floor(100000 + Math.random() * 900000)
    .toString()
    .slice(0, 6)

const normalizeMessage = (message: string) => message.toLowerCase().replace(/\s+/g, ' ').trim()

const safePatterns = [
  /не\s+(буду|стану|собираюсь)\s+(говорить|диктовать|сообщать|называть|отправлять|вводить)/,
  /не\s+(скажу|назову|сообщу|продиктую|отправлю|введу)/,
  /сам\s+(перезвоню|позвоню|проверю)/,
  /проверю\s+(в|через|по)/,
  /не\s+перейду\s+по\s+ссылке/,
  /не\s+буду\s+переводить/,
  /заверш(у|ить)\s+(звонок|разговор|диалог)/,
  /прекращ(аю|у)\s+(разговор|общение)/,
  /блокирую\s+(номер|контакт)/,
  /отказываюсь/,
  /откажусь/,
]

const negatedRiskPatterns = [
  /не\s+(скажу|назову|сообщу|продиктую|отправлю|введу)/,
  /не\s+(переведу|перевожу|буду\s+переводить)/,
  /не\s+(перейду|открою)\s+(по\s+)?(ссылке|сайт)/,
  /не\s+(подтвержу|выполню|продолжу)/,
]

const unsafeSignals = [
  { pattern: /(скажу|назову|сообщу|продиктую|отправлю|введу).{0,28}(код|смс|парол|данн)/, tag: 'код-подтверждения' },
  { pattern: /(переведу|перевожу|отправлю).{0,28}(деньг|сумм|оплат)/, tag: 'перевод-денег' },
  { pattern: /(перейду|открою).{0,24}(ссылк|сайт)/, tag: 'переход-по-ссылке' },
  { pattern: /(сообщу|скажу|отправлю|введу).{0,24}(карт|cvv|паспорт|данн)/, tag: 'передача-данных' },
  { pattern: /(подтвержу|выполню|продолжу).{0,28}(операц|шаг|инструкц)/, tag: 'доверие-сценарию' },
]

const evaluateUserReplyHeuristically = (userMessage: string): UserReplyEvaluation | null => {
  const normalized = normalizeMessage(userMessage)

  if (!normalized) {
    return null
  }

  if (safePatterns.some((pattern) => pattern.test(normalized))) {
    return {
      userWasSafe: true,
      userVerdict:
        'Безопасная реакция: вы не приняли правила мошенника и перевели проверку в независимый канал.',
      mistakeTag: null,
    }
  }

  if (negatedRiskPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      userWasSafe: true,
      userVerdict:
        'Ответ выглядит осторожным: вы отказываетесь от рискованных действий и удерживаете контроль.',
      mistakeTag: null,
    }
  }

  const unsafeMatch = unsafeSignals.find(({ pattern }) => pattern.test(normalized))
  if (unsafeMatch) {
    return {
      userWasSafe: false,
      userVerdict: 'Рискованный ответ: вы начали действовать по сценарию мошенника вместо независимой проверки.',
      mistakeTag: unsafeMatch.tag,
    }
  }

  return null
}

const extractJson = (content: string) => {
  const trimmed = content.trim()
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i)?.[1]
  if (fenced) {
    return fenced
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }

  return trimmed
}

const detectCodeRequest = (assistantReply: string) => /(код|смс|sms|одноразов|парол)/i.test(assistantReply)

const normalizeModelResponse = (raw: unknown): ChatResponse | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const data = raw as Partial<ChatResponse>
  if (typeof data.assistantReply !== 'string' || typeof data.coachNote !== 'string') {
    return null
  }

  const riskLevel =
    data.riskLevel === 'low' || data.riskLevel === 'medium' || data.riskLevel === 'high'
      ? data.riskLevel
      : 'medium'

  return {
    assistantReply: data.assistantReply.trim(),
    redFlags: Array.isArray(data.redFlags)
      ? data.redFlags.filter((item): item is string => typeof item === 'string').slice(0, 5)
      : [],
    coachNote: data.coachNote.trim(),
    riskLevel,
    conversationEnded: Boolean(data.conversationEnded),
    userVerdict:
      typeof data.userVerdict === 'string'
        ? data.userVerdict.trim()
        : 'Оценка требует более конкретной реплики пользователя.',
    userWasSafe: typeof data.userWasSafe === 'boolean' ? data.userWasSafe : null,
    mistakeTag: typeof data.mistakeTag === 'string' ? data.mistakeTag.trim().slice(0, 60) : null,
    asksForCode: Boolean(data.asksForCode),
  }
}

const systemPrompt = `Ты ведешь русскоязычную образовательную симуляцию по распознаванию мошенничества.

Главная роль:
- Ты играешь убедительного мошенника в учебной сцене.
- Ты не помощник, не консультант и не нейтральный собеседник.
- Твоя задача в assistantReply: продавить пользователя на рискованное действие через срочность, давление, авторитет, жалость, выгоду или запрет на проверку.

Поведение мошенника:
- Всегда отвечай только по-русски.
- Держись только выбранного сценария и не меняй тему.
- Говори коротко, уверенно и напористо.
- Используй реалистичные формулировки мошенника: "нужно срочно", "у нас мало времени", "операция уже в обработке", "не кладите трубку", "иначе доступ будет ограничен".
- Не задавай вежливые общие вопросы вроде "я задам вам пару вопросов", "чем могу помочь", "уточните, что вам нужно".
- Не звучь как ИИ, оператор поддержки, психолог или преподаватель.
- Если пользователь сопротивляется, усиливай давление и меняй тактику, а не выходи из роли.
- Если пользователь хочет проверить информацию, старайся помешать проверке: запрещай класть трубку, предлагай решить все прямо сейчас, ссылайся на срочность или регламент.

Ограничения безопасности:
- После каждой реплики отдельно анализируй, чем твое поведение выдает мошенника.
- Не используй реальные банки, адреса, телефоны и настоящие персональные данные.
- Не требуй от пользователя вводить реальные чувствительные данные. Вместо этого используй нейтральные формулировки вроде "код из сообщения", "данные карты", "подтверждение операции".
- Если пользователь пытается отправить реальные данные, мягко останови его и верни разговор в учебный режим, но не ломай стиль сцены.

Формат assistantReply:
- Это только реплика мошенника, без объяснений, без мета-комментариев, без упоминания правил.
- Реплика должна быть естественной, напористой и похожей на реальный развод.

Верни ТОЛЬКО JSON-объект без markdown и без дополнительного текста:
{
  "assistantReply": "реплика мошенника",
  "redFlags": ["короткий признак 1", "короткий признак 2"],
  "coachNote": "краткий разбор, почему это подозрительно и как действовать безопасно",
  "userVerdict": "одно короткое предложение о реакции пользователя",
  "userWasSafe": true,
  "mistakeTag": "короткий тег ошибки или null",
  "asksForCode": false,
  "riskLevel": "low | medium | high",
  "conversationEnded": false
}

Если оценка неочевидна, ставь userWasSafe=null и mistakeTag=null.
Если учебная сцена достигла цели, поставь conversationEnded=true и закончи реплику естественно.`

const createUserPrompt = (request: ChatRequest) => `Контекст тренировки:
- Сценарий: ${request.scenarioHint}
- Сложность: ${request.difficulty}
- Идентификатор сессии: ${request.sessionId}

История последних сообщений:
${request.history.map((message) => `${message.role}: ${message.content}`).join('\n')}

Новое сообщение пользователя:
user: ${request.userMessage}

Сформируй следующую реплику мошенника строго в рамках этого сценария и отдельный разбор. Не меняй тему сцены. Мошенник должен звучать убедительно, настойчиво и приземленно, а не как ИИ-помощник.

Правила оценки ответа пользователя:
- userVerdict должен быть коротким и прямым: безопасная или рискованная реакция, и почему.
- userWasSafe=true, если пользователь отказался сообщать код/данные, решил проверить источник, прекратить диалог или не переводить деньги.
- userWasSafe=false, если пользователь собирается продолжать разговор на условиях мошенника, сообщать код, данные карты, переводить деньги, переходить по ссылке или выполнять навязанные шаги.
- userWasSafe=null, если формулировка слишком общая и сделать вывод нельзя.
- если userWasSafe=false, укажи mistakeTag коротким тегом вроде "код-подтверждения", "доверие-сценарию", "переход-по-ссылке", "перевод-денег";
- если userWasSafe=true или userWasSafe=null, верни mistakeTag=null.
- asksForCode=true, если в assistantReply мошенник требует код из смс, код подтверждения, одноразовый пароль или аналогичный числовой код.`

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    const corsHeaders = buildCorsHeaders(origin, env.ALLOWED_ORIGIN)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    if (origin && !isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) {
      return json({ error: 'origin-not-allowed' }, 403, corsHeaders)
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true }, 200, corsHeaders)
    }

    if (request.method !== 'POST' || url.pathname !== '/api/chat') {
      return json({ error: 'not-found' }, 404, corsHeaders)
    }

    if (!env.GROQ_API_KEY) {
      return json({ error: 'missing-groq-api-key' }, 500, corsHeaders)
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json({ error: 'invalid-json' }, 400, corsHeaders)
    }

    const payload = body as Partial<ChatRequest>
    if (
      typeof payload.sessionId !== 'string' ||
      !Array.isArray(payload.history) ||
      typeof payload.difficulty !== 'string' ||
      typeof payload.scenarioHint !== 'string' ||
      typeof payload.userMessage !== 'string'
    ) {
      return json({ error: 'invalid-payload' }, 400, corsHeaders)
    }

    const sanitizedRequest: ChatRequest = {
      sessionId: payload.sessionId.slice(0, 80),
      history: sanitizeHistory(payload.history),
      difficulty: payload.difficulty.slice(0, 40),
      scenarioHint: payload.scenarioHint.slice(0, 80),
      userMessage: payload.userMessage.trim().slice(0, 900),
    }

    if (!sanitizedRequest.userMessage) {
      return json({ error: 'empty-user-message' }, 400, corsHeaders)
    }

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL || 'llama-3.1-8b-instant',
        temperature: 0.45,
        max_tokens: 700,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: createUserPrompt(sanitizedRequest) },
        ],
      }),
    })

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text()
      return json(
        {
          error: 'groq-request-failed',
          details: errorText.slice(0, 300),
        },
        502,
        corsHeaders,
      )
    }

    const groqData = (await groqResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const rawContent = groqData.choices?.[0]?.message?.content
    if (!rawContent) {
      return json({ error: 'empty-model-response' }, 502, corsHeaders)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(extractJson(rawContent))
    } catch {
      return json({ error: 'unparseable-model-response' }, 502, corsHeaders)
    }

    const normalized = normalizeModelResponse(parsed)
    if (!normalized) {
      return json({ error: 'invalid-model-schema' }, 502, corsHeaders)
    }

    const heuristicEvaluation = evaluateUserReplyHeuristically(sanitizedRequest.userMessage)
    const resolvedUserWasSafe = heuristicEvaluation?.userWasSafe ?? normalized.userWasSafe
    const resolvedMistakeTag = heuristicEvaluation?.mistakeTag ?? normalized.mistakeTag

    return json(
      {
        ...normalized,
        userWasSafe: resolvedUserWasSafe,
        userVerdict:
          heuristicEvaluation?.userVerdict ??
          normalized.userVerdict ??
          'Оценка требует более конкретной формулировки ответа.',
        mistakeTag: resolvedUserWasSafe === false ? resolvedMistakeTag : null,
        simulatedCode:
          normalized.asksForCode || detectCodeRequest(normalized.assistantReply)
            ? generateTrainingCode()
            : null,
      },
      200,
      corsHeaders,
    )
  },
}
