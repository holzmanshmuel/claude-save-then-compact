import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Flow } from '../types'

// Save first, then compact.
//
// A manual /compact is held while the session writes its handover notes; the
// compaction runs once the save is confirmed: the reply carries a one-time
// code, and (when a handover file is configured) that file was written after
// the request. The same flow starts by itself when the context passes the
// threshold. The engine's own auto-compaction (near the window's limit) passes
// through untouched apart from summary instructions: there is no room left for
// a save turn by then.
//
// Settings (environment variables, all optional):
//   SAVE_COMPACT_AT_TOKENS      start the flow at this many context tokens (default 400000, min 50000)
//   SAVE_COMPACT_HANDOVER_FILE  absolute path of the file Claude must update before compacting
//   SAVE_COMPACT_LANES_DIR      absolute path of a folder of dated folders (YYYY-MM-DD) holding
//                               <CLAUDE_LANE>.md; the newest one is used when CLAUDE_LANE is set

const DEFAULT_AT = 400_000
const MIN_AT = 50_000
const MAX_WAIT_TURNS = 3 // turns to wait for the save reply before giving up
const MAX_WAIT_MS = 20 * 60_000
const COOLDOWN_MS = 30 * 60_000 // after a failed or refused save
const NAME = 'save-then-compact'

const IDLE: Flow = {
  phase: 'idle',
  nonce: '',
  why: '',
  instructions: '',
  handoverFile: '',
  since: 0,
  turnsWaited: 0,
  bypass: false,
  cooldownUntil: 0,
}

const flow = atom({ plugin: 'save-then-compact', key: 'flow' } as const, IDLE, { shape: 'flow-2' })

const KEEP =
  'Keep in the summary: the handover file path (if any), every open pull request with its head commit, ' +
  'running jobs with their ids and output paths, pending approvals, the exact next step, and ' +
  "the user's latest requests in their own words. First thing after this compaction: re-read " +
  'the handover notes before doing anything else.'

const LANE = /^[A-Z][A-Za-z0-9-]{1,23}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

async function threshold($: any): Promise<number> {
  const raw = await $.env.get('SAVE_COMPACT_AT_TOKENS')
  const n = raw && /^\d{1,9}$/.test(raw) ? Number(raw) : DEFAULT_AT
  return Math.max(MIN_AT, n)
}

async function regularFile($: any, path: string): Promise<boolean> {
  try {
    const st = await $.fs.stat(path)
    return st.kind === 'file' && !st.isLink
  } catch {
    return false
  }
}

async function handoverFile($: any): Promise<string> {
  const direct = await $.env.get('SAVE_COMPACT_HANDOVER_FILE')
  if (direct && direct.startsWith('/') && !direct.includes('\0')) {
    return (await regularFile($, direct)) ? direct : ''
  }
  const root = await $.env.get('SAVE_COMPACT_LANES_DIR')
  const lane = await $.env.get('CLAUDE_LANE')
  if (!root || !root.startsWith('/') || !lane || !LANE.test(lane)) return ''
  let days: string[] = []
  try {
    days = (await $.fs.list(root))
      .filter((d: { kind: string; name: string }) => d.kind === 'dir' && DAY.test(d.name))
      .map((d: { name: string }) => d.name)
      .sort()
      .reverse()
  } catch {
    return ''
  }
  for (const day of days) {
    const path = `${root.replace(/\/+$/, '')}/${day}/${lane}.md`
    if (await regularFile($, path)) return path
  }
  return ''
}

function savePrompt(f: Flow): string {
  const where = f.handoverFile
    ? `the handover notes in ${f.handoverFile} (update them in place)`
    : 'your handover notes (wherever this project keeps them: a notes file, the issue tracker, or memory)'
  return [
    `${NAME}: this session is about to be compacted (${f.why}). Before that, save everything you would need to continue.`,
    `Update ${where}: current state; open pull requests with head commits; pending approvals; running jobs with ids and output paths;`,
    'the exact next step; anything waiting on the user; open questions; and anything that so far lives only in this conversation.',
    'Do not start other work and do not wait on anything. When the notes are written, reply with exactly this line and nothing after it:',
    `SAVED ${f.nonce}`,
  ].join('\n')
}

async function startSave($: any, why: string, instructions: string): Promise<void> {
  const now = await $.clock.now()
  const next: Flow = {
    ...IDLE,
    phase: 'saving',
    nonce: `stc-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    why,
    instructions,
    handoverFile: await handoverFile($),
    since: now,
  }
  await update($, flow, () => next)
  $.ui.status(`${NAME}: saving before compaction`)
  void $.prompt.submit({ text: savePrompt(next) })
}

async function giveUp($: any, reason: string): Promise<void> {
  const now = await $.clock.now()
  await update($, flow, f => ({ ...IDLE, cooldownUntil: now + COOLDOWN_MS, bypass: f.bypass }))
  $.ui.status(undefined)
  $.ui.toast(`${NAME}: not compacted. ${reason}`)
}

async function compactNow($: any, f: Flow, attempt = 0): Promise<void> {
  try {
    await update($, flow, cur => ({ ...cur, phase: 'compacting' }))
    const instructions = [f.instructions, KEEP].filter(Boolean).join('\n\n')
    const result = await $.session.compact({ instructions })
    if (result && 'skip' in result && result.skip) {
      await giveUp($, `Compaction was skipped: ${result.skip}`)
      return
    }
    await update($, flow, () => IDLE)
    $.ui.status(undefined)
    $.ui.toast(`${NAME}: saved, then compacted.`)
  } catch {
    // A turn is running (a queued message started one): try again shortly.
    if (attempt < 5) {
      $.clock.after(5_000, () => void compactNow($, f, attempt + 1))
    } else {
      await giveUp($, 'The session stayed busy; run /compact again when it is idle.')
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'compact-now',
      description: 'Compact right away, skipping the save step (save-then-compact)',
    })
    await $.command.register({
      name: 'save-compact-status',
      description: 'Show what save-then-compact is doing',
    })
    return next(e)
  })

  on('command.run', { command: 'compact-now' }, async ($, e) => {
    await update($, flow, f => ({ ...f, bypass: true }))
    try {
      const result = await $.session.compact({ instructions: e.args || undefined })
      await update($, flow, () => IDLE)
      return { text: result && 'skip' in result && result.skip ? `Not compacted: ${result.skip}` : 'Compacted (save skipped).' }
    } catch {
      await update($, flow, f => ({ ...f, bypass: false }))
      return { text: 'Not compacted: a turn is running. Try again when the session is idle.' }
    }
  })

  on('command.run', { command: 'save-compact-status' }, async $ => {
    const f = await read($, flow)
    const ctx = (await $.session.usage()).context
    return {
      text:
        `${NAME}: ${f.phase}${f.why ? ` (${f.why})` : ''}. Context ${ctx.tokens ?? '?'} tokens; ` +
        `auto save-and-compact at ${await threshold($)}. Handover file: ${f.handoverFile || (await handoverFile($)) || 'none set'}.`,
    }
  })

  // Hold a manual /compact (and honour our own bypass) and run the save first.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // a subagent's own compaction
    const f = await read($, flow)
    if (f.bypass) {
      await update($, flow, cur => ({ ...cur, bypass: false }))
      return next(e)
    }
    if (e.trigger === 'manual') {
      if (f.phase !== 'idle') return { skip: `${NAME}: a save is already running; compaction follows it.` }
      await startSave($, 'you ran /compact', e.instructions ?? '')
      return { skip: `${NAME}: saving the handover notes first; compaction follows automatically.` }
    }
    if (e.trigger === 'auto') {
      // No room for a save turn at the window's limit: pass it on, but steer the summary.
      return next({ ...e, instructions: [e.instructions, KEEP].filter(Boolean).join('\n\n') })
    }
    return next(e) // 'plugin' (ours) and 'precompute'
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const f = await read($, flow)
    const now = await $.clock.now()

    if (f.phase === 'saving') {
      const said = (result.text ?? '').trim().split('\n').some(line => line.trim() === `SAVED ${f.nonce}`)
      if (!said) {
        const waited = f.turnsWaited + 1
        if (e.reason !== 'answer' || waited >= MAX_WAIT_TURNS || now - f.since > MAX_WAIT_MS) {
          await giveUp($, e.reason === 'aborted' ? 'The save was interrupted.' : 'The save was not confirmed.')
        } else {
          await update($, flow, cur => ({ ...cur, turnsWaited: waited }))
        }
        return result
      }
      if (f.handoverFile) {
        try {
          const st = await $.fs.stat(f.handoverFile)
          if (st.mtimeMs < f.since) {
            await giveUp($, `The reply said SAVED but ${f.handoverFile} was not written.`)
            return result
          }
        } catch {
          await giveUp($, 'The handover file could not be read.')
          return result
        }
      }
      $.clock.after(1_500, () => void compactNow($, f))
      return result
    }

    if (f.phase === 'idle' && now >= f.cooldownUntil && e.reason === 'answer') {
      const tokens = (await $.session.usage()).context.tokens ?? 0
      const at = await threshold($)
      if (tokens >= at) await startSave($, `the context reached ${tokens} tokens`, '')
    }
    return result
  })
}
