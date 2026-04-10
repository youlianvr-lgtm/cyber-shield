import type { MistakeTagCount, ProgressState } from '../types'

const STORAGE_KEY = 'cyber-shield-progress-v1'

export const emptyProgressState = (): ProgressState => ({
  completedScenarioIds: [],
  chatSessionsCount: 0,
  mistakeTagsCount: {},
  lastVisitedAt: null,
})

export const loadProgress = (): ProgressState => {
  if (typeof window === 'undefined') {
    return emptyProgressState()
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return emptyProgressState()
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ProgressState>
    return {
      completedScenarioIds: Array.isArray(parsed.completedScenarioIds)
        ? parsed.completedScenarioIds
        : [],
      chatSessionsCount:
        typeof parsed.chatSessionsCount === 'number' ? parsed.chatSessionsCount : 0,
      mistakeTagsCount:
        parsed.mistakeTagsCount && typeof parsed.mistakeTagsCount === 'object'
          ? (parsed.mistakeTagsCount as MistakeTagCount)
          : {},
      lastVisitedAt:
        typeof parsed.lastVisitedAt === 'string' ? parsed.lastVisitedAt : null,
    }
  } catch {
    return emptyProgressState()
  }
}

export const saveProgress = (progress: ProgressState) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress))
}
