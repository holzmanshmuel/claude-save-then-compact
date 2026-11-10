export type Phase = 'idle' | 'saving' | 'compacting'

export type Flow = {
  phase: Phase
  nonce: string
  why: string
  instructions: string
  handoverFile: string
  since: number
  turnsWaited: number
  bypass: boolean
  cooldownUntil: number
}

declare module 'claude-code' {
  interface PluginState {
    'save-then-compact': { flow: Shaped<Flow> }
  }
}
