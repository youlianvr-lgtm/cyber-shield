export type DangerLevel = 'low' | 'medium' | 'high'
export type ChatInputMode = 'speech' | 'action' | 'mixed' | 'unclear'

export type RecognitionCard = {
  title: string
  body: string
  cue: string
}

export type ChatTechnique = {
  title: string
  description: string
}

export type ScenarioChoice = {
  id: string
  label: string
  outcome: 'safe' | 'risk'
  explanation: string
  coachTip: string
  nextStageId?: string
  mistakeTags?: string[]
}

export type ScenarioStage = {
  id: string
  message: string
  prompt: string
  redFlags: string[]
  choices: ScenarioChoice[]
}

export type Scenario = {
  id: string
  title: string
  category: string
  intro: string
  difficulty: string
  tags: string[]
  stages: ScenarioStage[]
  summary: string
}

export type MistakeTagCount = Record<string, number>

export type ProgressState = {
  completedScenarioIds: string[]
  chatSessionsCount: number
  mistakeTagsCount: MistakeTagCount
  lastVisitedAt: string | null
}

export type ChoiceResult = {
  stageId: string
  choiceId: string
  outcome: 'safe' | 'risk'
  explanation: string
  coachTip: string
}

export type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  content: string
}

export type ChatInsight = {
  redFlags: string[]
  techniques: ChatTechnique[]
  coachNote: string
  riskLevel: DangerLevel
  conversationEnded: boolean
  userVerdict: string
  userWasSafe: boolean | null
  mistakeTag: string | null
  inputMode: ChatInputMode
  simulatedCode: string | null
}

export type ChatApiRequest = {
  sessionId: string
  history: ChatMessage[]
  difficulty: string
  scenarioHint: string
  userMessage: string
}

export type ChatApiResponse = {
  assistantReply: string
  redFlags: string[]
  techniques: ChatTechnique[]
  coachNote: string
  riskLevel: DangerLevel
  conversationEnded: boolean
  userVerdict: string
  userWasSafe: boolean | null
  mistakeTag: string | null
  inputMode: ChatInputMode
  simulatedCode: string | null
}
