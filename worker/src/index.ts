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
  }
}

const systemPrompt = `Ты ведешь русскоязычную образовательную симуляцию для сайта по защите от мошенничества.

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
- В банковском сценарии дави на страх потери денег и блокировки.
- В сценарии с родственником дави на эмоции, срочность и чувство вины.
- В доставке дави на отмену заказа, потерю посылки или срочный платеж.
- В подработке дави на быстрый доход, ограниченное место и срочный депозит.

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
  "coachNote": "краткий разбор, почему это подозрительно и что делать безопасно",
  "riskLevel": "low | medium | high",
  "conversationEnded": false
}

Если учебная сцена уже достигла цели, поставь conversationEnded=true и закончи реплику естественно.`

const createUserPrompt = (request: ChatRequest) => `Контекст тренировки:
- Сценарий: ${request.scenarioHint}
- Сложность: ${request.difficulty}
- Идентификатор сессии: ${request.sessionId}

История последних сообщений:
${request.history.map((message) => `${message.role}: ${message.content}`).join('\n')}

Новое сообщение пользователя:
user: ${request.userMessage}

Сформируй следующую реплику мошенника строго в рамках этого сценария и отдельный разбор. Не меняй тему сцены. Мошенник должен звучать убедительно, настойчиво и приземленно, а не как ИИ-помощник.`

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

    return json(normalized, 200, corsHeaders)
  },
}
