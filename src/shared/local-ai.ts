/** Offline AI backend contract shared by main, preload and the renderer. */

export type LocalAiStepId = 'whisper-runtime' | 'whisper-model' | 'ollama-runtime' | 'planner-model'

export interface LocalAiProgress {
  step: LocalAiStepId
  label: string
  /** null while a step has no meaningful ratio (installing, extracting). */
  percent: number | null
  detail?: string
}

export interface LocalAiStatus {
  gpuAvailable: boolean
  gpuName: string | null
  whisperRuntime: boolean
  whisperModelReady: boolean
  ollamaRunning: boolean
  ollamaModels: string[]
  plannerReady: boolean
  ready: boolean
  pythonPath: string
  enginePath: string
}
