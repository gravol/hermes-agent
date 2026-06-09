/**
 * PromptOverlay — renders the active blocking prompt and binds each answer/cancel
 * to the matching `*.respond` RPC (spec §4 reply contract; §8 #6 deadlock fix):
 *   clarify.respond {answer, request_id} · approval.respond {choice, session_id} ·
 *   sudo.respond {password, request_id} · secret.respond {value, request_id}.
 * Every cancel path (Esc/Ctrl+C) sends the deny/empty reply so the agent unblocks.
 *
 * `onRespond` is the entry-wired boundary callback (fires `gateway.request`); the
 * overlay also clears the store prompt so the composer returns. Narrowing is done
 * with reactive `as*()` accessors so each sub-prompt gets its typed payload.
 */
import { Match, Switch } from 'solid-js'

import { deferClose } from '../../logic/defer.ts'
import type { SessionStore } from '../../logic/store.ts'
import { ApprovalPrompt } from './approvalPrompt.tsx'
import { ClarifyPrompt } from './clarifyPrompt.tsx'
import { ConfirmPrompt } from './confirmPrompt.tsx'
import { MaskedPrompt } from './maskedPrompt.tsx'

export interface PromptOverlayProps {
  readonly store: SessionStore
  readonly onRespond: (method: string, params: Record<string, unknown>) => void
  readonly sessionId: () => string | undefined
}

export function PromptOverlay(props: PromptOverlayProps) {
  const prompt = () => props.store.state.prompt
  // Defer the prompt-clear (which remounts + refocuses the composer) past the
  // CURRENT keystroke, so the key that answered the prompt (Enter/y/select) can't
  // leak into the freshly-focused composer (e.g. `/clear`→y left "y" in the input).
  const clearSoon = () => deferClose(() => props.store.clearPrompt())
  const respond = (method: string, params: Record<string, unknown>) => {
    props.onRespond(method, params)
    clearSoon()
  }

  const asApproval = () => {
    const p = prompt()
    return p && p.kind === 'approval' ? p : undefined
  }
  const asClarify = () => {
    const p = prompt()
    return p && p.kind === 'clarify' ? p : undefined
  }
  const asSudo = () => {
    const p = prompt()
    return p && p.kind === 'sudo' ? p : undefined
  }
  const asSecret = () => {
    const p = prompt()
    return p && p.kind === 'secret' ? p : undefined
  }
  const asConfirm = () => {
    const p = prompt()
    return p && p.kind === 'confirm' ? p : undefined
  }

  return (
    <Switch>
      <Match when={asApproval()}>
        {p => (
          <ApprovalPrompt
            command={p().command}
            description={p().description}
            onChoose={choice => respond('approval.respond', { choice, session_id: props.sessionId() })}
            onCancel={() => respond('approval.respond', { choice: 'deny', session_id: props.sessionId() })}
          />
        )}
      </Match>
      <Match when={asClarify()}>
        {p => (
          <ClarifyPrompt
            question={p().question}
            choices={p().choices}
            onAnswer={answer => respond('clarify.respond', { answer, request_id: p().requestId })}
            onCancel={() => respond('clarify.respond', { answer: '', request_id: p().requestId })}
          />
        )}
      </Match>
      <Match when={asSudo()}>
        {p => (
          <MaskedPrompt
            icon="🔐"
            label="sudo password"
            onSubmit={value => respond('sudo.respond', { password: value, request_id: p().requestId })}
            onCancel={() => respond('sudo.respond', { password: '', request_id: p().requestId })}
          />
        )}
      </Match>
      <Match when={asSecret()}>
        {p => (
          <MaskedPrompt
            icon="🔑"
            label={`Secret: ${p().envVar}`}
            sub={p().prompt}
            onSubmit={value => respond('secret.respond', { request_id: p().requestId, value })}
            onCancel={() => respond('secret.respond', { request_id: p().requestId, value: '' })}
          />
        )}
      </Match>
      <Match when={asConfirm()}>
        {p => (
          <ConfirmPrompt
            message={p().message}
            onYes={() => {
              p().onConfirm()
              clearSoon()
            }}
            onNo={clearSoon}
          />
        )}
      </Match>
    </Switch>
  )
}
