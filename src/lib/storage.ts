import type { MistakeTagCount, ProgressState } from '../types'

const STORAGE_KEY_V1 = 'cyber-shield-progress-v1'
const STORAGE_KEY_V2 = 'moshennik-net-progress-v2'

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

  const rawV2 = window.localStorage.getItem(STORAGE_KEY_V2)
  if (rawV2) {
    try {
      const parsed = JSON.parse(rawV2) as Partial<ProgressState>
      return {
        completedScenarioIds: Array.isArray(parsed.completedScenarioIds) ? parsed.completedScenarioIds : [],
        chatSessionsCount: typeof parsed.chatSessionsCount === 'number' ? parsed.chatSessionsCount : 0,
        mistakeTagsCount:
          parsed.mistakeTagsCount && typeof parsed.mistakeTagsCount === 'object'
            ? (parsed.mistakeTagsCount as MistakeTagCount)
            : {},
        lastVisitedAt: typeof parsed.lastVisitedAt === 'string' ? parsed.lastVisitedAt : null,
      }
    } catch {
      return emptyProgressState()
    }
  }

  const rawV1 = window.localStorage.getItem(STORAGE_KEY_V1)
  if (!rawV1) {
    return emptyProgressState()
  }

  try {
    const parsed = JSON.parse(rawV1) as Partial<ProgressState>
    const migrated: ProgressState = {
      completedScenarioIds: [],
      chatSessionsCount: typeof parsed.chatSessionsCount === 'number' ? parsed.chatSessionsCount : 0,
      mistakeTagsCount: {},
      lastVisitedAt: typeof parsed.lastVisitedAt === 'string' ? parsed.lastVisitedAt : null,
    }

    window.localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(migrated))
    window.localStorage.removeItem(STORAGE_KEY_V1)

    return migrated
  } catch {
    return emptyProgressState()
  }
}

export const saveProgress = (progress: ProgressState) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(progress))
}
