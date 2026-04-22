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

type ChatInputMode = 'speech' | 'action' | 'mixed' | 'unclear'

type ChatTechnique = {
  title: string
  description: string
}

type ChatResponse = {
  assistantReply: string
  redFlags: string[]
  techniques: ChatTechnique[]
  coachNote: string
  riskLevel: 'low' | 'medium' | 'high'
  conversationEnded: boolean
  userVerdict: string
  userWasSafe: boolean | null
  mistakeTag: string | null
  inputMode: ChatInputMode
  asksForCode: boolean
}

type UserReplyEvaluation = {
  userWasSafe: boolean | null
  userVerdict: string
  mistakeTag: string | null
  inputMode: ChatInputMode
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
  /не\s+(буду|стану|собираюсь)\s+(говорить|диктовать|сообщать|называть|отправлять|вводить)/i,
  /не\s+(скажу|назову|сообщу|продиктую|отправлю|введу)/i,
  /сам\s+(перезвоню|позвоню|проверю)/i,
  /проверю\s+(в|через|по)/i,
  /не\s+перейду\s+по\s+ссылке/i,
  /не\s+буду\s+переводить/i,
  /заверш(у|ить|аю)\s+(звонок|разговор|диалог)/i,
  /прекращ(аю|у)\s+(разговор|общение)/i,
  /блокирую\s+(номер|контакт)/i,
  /кладу\s+трубку/i,
  /отказываюсь/i,
  /откажусь/i,
]

const negatedRiskPatterns = [
  /не\s+(скажу|назову|сообщу|продиктую|отправлю|введу)/i,
  /не\s+(переведу|перевожу|буду\s+переводить)/i,
  /не\s+(перейду|открою)\s+(по\s+)?(ссылке|сайт)/i,
  /не\s+(подтвержу|выполню|продолжу)/i,
]

const riskySignals = [
  {
    pattern: /(скажу|назову|сообщу|продиктую|отправлю|введу).{0,28}(код|смс|парол|данн)/i,
    tag: 'код-подтверждения',
  },
  {
    pattern: /(переведу|перевожу|отправлю).{0,28}(деньг|сумм|оплат)/i,
    tag: 'перевод-денег',
  },
  {
    pattern: /(перейду|открою).{0,24}(ссылк|сайт)/i,
    tag: 'переход-по-ссылке',
  },
  {
    pattern: /(сообщу|скажу|отправлю|введу).{0,24}(карт|cvv|паспорт|данн)/i,
    tag: 'передача-данных',
  },
  {
    pattern: /(подтвержу|выполню|продолжу).{0,28}(операц|шаг|инструкц)/i,
    tag: 'доверие-сценарию',
  },
]

const actionMarkers = [
  /\b(перезвоню|позвоню|проверю|завершу|завершаю|прекращаю|кладу трубку|блокирую|переведу|перевожу|перейду|открою|введу|диктую|продиктую|подтвержу|выполню|продолжу)\b/i,
  /\b(отправлю|сообщу)\b.{0,24}\b(код|смс|данные|деньги|карту|cvv)\b/i,
]

const speechMarkers = [
  /^[«"]/,
  /[?!]$/,
  /\b(скажу|отвечу|отвечаю|говорю|спрошу|напишу|пишу)\b/i,
  /^(нет|кто вы|зачем|почему|с какой стати|подождите)/i,
]

const delayOrQuestionPatterns = [
  /\b(подождите|секунду|подумаю|уточню|проверю сначала)\b/i,
  /\?/,
]

const detectInputMode = (userMessage: string): ChatInputMode => {
  const normalized = normalizeMessage(userMessage)
  if (!normalized) {
    return 'unclear'
  }

  const hasAction = actionMarkers.some((pattern) => pattern.test(normalized))
  const hasSpeech = speechMarkers.some((pattern) => pattern.test(userMessage.trim()))

  if (hasAction && hasSpeech) {
    return 'mixed'
  }

  if (hasAction) {
    return 'action'
  }

  if (hasSpeech) {
    return 'speech'
  }

  return 'unclear'
}

const evaluateUserReplyHeuristically = (userMessage: string): UserReplyEvaluation | null => {
  const normalized = normalizeMessage(userMessage)
  const inputMode = detectInputMode(userMessage)

  if (!normalized) {
    return null
  }

  if (safePatterns.some((pattern) => pattern.test(normalized))) {
    return {
      userWasSafe: true,
      userVerdict:
        'Безопасная реакция: вы оборвали давление, отказались от опасного шага и перевели проверку в независимый канал.',
      mistakeTag: null,
      inputMode,
    }
  }

  if (negatedRiskPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      userWasSafe: true,
      userVerdict:
        'Ответ выглядит осторожным: вы прямо отказались от рискованного действия и не приняли правила мошенника.',
      mistakeTag: null,
      inputMode,
    }
  }

  const unsafeMatch = riskySignals.find(({ pattern }) => pattern.test(normalized))
  if (unsafeMatch) {
    return {
      userWasSafe: false,
      userVerdict:
        'Рискованный ответ: вы явно соглашаетесь на действие в интересах мошенника, а не на самостоятельную проверку.',
      mistakeTag: unsafeMatch.tag,
      inputMode,
    }
  }

  if (delayOrQuestionPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      userWasSafe: null,
      userVerdict:
        'Пока это выглядит как вопрос, пауза или сомнение. Ошибка не засчитывается, пока вы не совершили рискованный шаг.',
      mistakeTag: null,
      inputMode,
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

const detectCodeRequest = (assistantReply: string) =>
  /(код|смс|sms|одноразов|парол|подтверждени)/i.test(assistantReply)

const normalizeTechniques = (value: unknown): ChatTechnique[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const entry = item as Partial<ChatTechnique>
      if (typeof entry.title !== 'string' || typeof entry.description !== 'string') {
        return null
      }

      return {
        title: entry.title.trim().slice(0, 80),
        description: entry.description.trim().slice(0, 220),
      }
    })
    .filter((item): item is ChatTechnique => Boolean(item))
    .slice(0, 4)
}

const normalizeRedFlags = (value: unknown) => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5)
}

const normalizeInputMode = (value: unknown): ChatInputMode => {
  if (value === 'speech' || value === 'action' || value === 'mixed' || value === 'unclear') {
    return value
  }

  return 'unclear'
}

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
    redFlags: normalizeRedFlags(data.redFlags),
    techniques: normalizeTechniques(data.techniques),
    coachNote: data.coachNote.trim(),
    riskLevel,
    conversationEnded: Boolean(data.conversationEnded),
    userVerdict:
      typeof data.userVerdict === 'string' && data.userVerdict.trim()
        ? data.userVerdict.trim()
        : 'Оценка требует более конкретной формулировки ответа пользователя.',
    userWasSafe: typeof data.userWasSafe === 'boolean' ? data.userWasSafe : null,
    mistakeTag: typeof data.mistakeTag === 'string' ? data.mistakeTag.trim().slice(0, 60) : null,
    inputMode: normalizeInputMode(data.inputMode),
    asksForCode: Boolean(data.asksForCode),
  }
}

const systemPrompt = `Ты ведешь русскоязычную учебную симуляцию по распознаванию мошенничества.

Роль и стиль:
- Ты играешь убедительного мошенника внутри учебной сцены.
- В assistantReply ты всегда пишешь только следующую реплику мошенника: без объяснений, без мета-комментариев, без упоминания правил и без выхода из роли.
- Ты не помощник, не консультант и не нейтральный оператор.
- Говори коротко, дави уверенно и приземленно, как реальный злоумышленник.
- Усиливай давление через срочность, авторитет, страх потери, жалость, выгоду и запрет на независимую проверку.
- Если пользователь сопротивляется, меняй тактику давления, но не меняй сценарий.
- Не уходи в общие вежливые вопросы и не предлагай безопасные решения.

Оценка ответа пользователя:
- Определяй inputMode:
  - speech: пользователь пишет, что именно говорит мошеннику.
  - action: пользователь описывает действие или следующий шаг.
  - mixed: в одном сообщении есть и действие, и реплика.
  - unclear: формулировка слишком размыта.
- Ошибку можно засчитывать только если пользователь явно совершает рискованный шаг или прямо соглашается его совершить.
- Если пользователь только спрашивает, сомневается, тянет время, ругается, требует доказательства или пишет слишком общо, это не ошибка: userWasSafe=null и mistakeTag=null.
- userWasSafe=true только если пользователь явно отказывается, завершает контакт, не передает данные, не переходит по ссылке, не переводит деньги и переводит проверку в независимый канал.
- userWasSafe=false только если пользователь явно сообщает код, данные, переводит деньги, переходит по ссылке, подтверждает операцию или продолжает действовать по сценарию мошенника.
- mistakeTag заполняй только при userWasSafe=false коротким тегом вроде "код-подтверждения", "перевод-денег", "переход-по-ссылке", "передача-данных", "доверие-сценарию".
- Если userWasSafe=true или userWasSafe=null, mistakeTag должен быть null.

Разбор:
- redFlags: короткие маркеры того, что выдает мошенника в твоей текущей реплике.
- techniques: список приемов давления. Каждый элемент должен содержать title и description.
- coachNote: развернутый разбор на 2-3 предложения. Назови техники давления и объясни, как именно они работают в этой реплике.

Ограничения безопасности:
- Не используй реальные банки, компании, адреса, телефоны и персональные данные.
- Не проси пользователя вводить реальные чувствительные данные. Используй нейтральные формулировки вроде "код из сообщения", "данные карты", "подтверждение операции".
- Если пользователь начинает писать что-то похожее на реальные данные, не повторяй эти данные в ответе.

Финал сцены:
- conversationEnded=true, если пользователь явно завершил контакт безопасно или уже явно совершил ключевой рискованный шаг и сцену можно естественно закончить.
- asksForCode=true, если в assistantReply мошенник просит код из SMS, push, одноразовый пароль или аналогичный код.

Верни только JSON-объект без markdown и без дополнительного текста:
{
  "assistantReply": "реплика мошенника",
  "redFlags": ["короткий признак 1", "короткий признак 2"],
  "techniques": [
    {
      "title": "название техники",
      "description": "как именно эта техника работает в текущей реплике"
    }
  ],
  "coachNote": "развернутый разбор, почему реплика опасна и как она давит на пользователя",
  "userVerdict": "краткая оценка реакции пользователя",
  "userWasSafe": true,
  "mistakeTag": null,
  "inputMode": "speech",
  "asksForCode": false,
  "riskLevel": "low",
  "conversationEnded": false
}`

const createUserPrompt = (request: ChatRequest) => `Контекст тренировки:
- Сценарий: ${request.scenarioHint}
- Сложность: ${request.difficulty}
- Идентификатор сессии: ${request.sessionId}

История последних сообщений:
${request.history.map((message) => `${message.role}: ${message.content}`).join('\n')}

Новое сообщение пользователя:
user: ${request.userMessage}

Сформируй следующую реплику мошенника строго внутри этого сценария и отдельно оцени ответ пользователя по правилам из system prompt.
Помни:
- не засчитывай ошибку за сам факт сообщения;
- засчитывай ее только при явном опасном действии или прямом согласии на него;
- вопрос, сомнение, торг, ругань, затягивание времени или слишком общая фраза не являются ошибкой;
- inputMode обязан описывать, написал ли пользователь реплику, действие, смешанный ответ или неясный ответ.`

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
        temperature: 0.55,
        max_tokens: 900,
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

    const heuristicEvaluation =
      normalized.userWasSafe === null ? evaluateUserReplyHeuristically(sanitizedRequest.userMessage) : null

    const resolvedInputMode =
      normalized.inputMode === 'unclear'
        ? heuristicEvaluation?.inputMode ?? normalized.inputMode
        : normalized.inputMode
    const resolvedUserWasSafe = heuristicEvaluation?.userWasSafe ?? normalized.userWasSafe
    const resolvedMistakeTag =
      resolvedUserWasSafe === false ? heuristicEvaluation?.mistakeTag ?? normalized.mistakeTag : null

    return json(
      {
        ...normalized,
        inputMode: resolvedInputMode,
        userWasSafe: resolvedUserWasSafe,
        userVerdict:
          heuristicEvaluation?.userVerdict ??
          normalized.userVerdict ??
          'Оценка требует более конкретной формулировки ответа.',
        mistakeTag: resolvedMistakeTag,
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
