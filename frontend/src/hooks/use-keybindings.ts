import * as React from 'react'

export type FocusKind =
  | 'input'
  | 'textarea'
  | 'select'
  | 'contenteditable'
  | 'other'

export type KeybindingMatchContext = {
  command: string
  keys: string
  event: KeyboardEvent
  activeElement: Element | null
  focusKind: FocusKind
}

export type Keybinding = {
  command: string
  keys: string
  handler: (ctx: KeybindingMatchContext) => void
  when?: (
    ctx: Omit<KeybindingMatchContext, 'command' | 'keys' | 'event'>,
  ) => boolean
  allowInInput?: boolean
  allowWhenDefaultPrevented?: boolean
  preventDefault?: boolean
  stopPropagation?: boolean
  ignoreRepeat?: boolean
}

type ParsedKeybinding = {
  key: string
  mod: boolean
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

function isMacPlatform() {
  if (typeof navigator === 'undefined') return false
  const platform =
    (navigator as any).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent
  return /mac/i.test(String(platform))
}

function focusKindFromTarget(target: EventTarget | null): FocusKind {
  const el = target as any
  if (!el || el.nodeType !== 1) return 'other'

  const tag = String(el.tagName ?? '').toLowerCase()
  if (tag === 'input') return 'input'
  if (tag === 'textarea') return 'textarea'
  if (tag === 'select') return 'select'

  const editable = Boolean(el.isContentEditable)
  return editable ? 'contenteditable' : 'other'
}

function normalizeKey(key: string) {
  const trimmed = key.trim()
  const lower = trimmed.toLowerCase()
  if (lower === 'space' || lower === 'spacebar') return ' '
  if (lower === 'esc') return 'escape'
  if (lower === 'cmd') return 'meta'
  if (lower === 'command') return 'meta'
  if (lower === 'control') return 'ctrl'
  if (lower === 'option') return 'alt'
  if (trimmed.length === 1) return lower
  return lower
}

function parseKeybinding(keys: string): ParsedKeybinding | null {
  const parts = keys
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const parsed: ParsedKeybinding = {
    key: '',
    mod: false,
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
  }

  for (const raw of parts) {
    const token = normalizeKey(raw)
    if (token === 'mod') parsed.mod = true
    else if (token === 'meta') parsed.meta = true
    else if (token === 'ctrl') parsed.ctrl = true
    else if (token === 'shift') parsed.shift = true
    else if (token === 'alt') parsed.alt = true
    else parsed.key = token
  }

  if (!parsed.key) return null
  return parsed
}

function matchesKeybinding(
  event: KeyboardEvent,
  binding: ParsedKeybinding,
  isMac: boolean,
) {
  const wantsMeta = binding.meta || (binding.mod && isMac)
  const wantsCtrl = binding.ctrl || (binding.mod && !isMac)

  if (Boolean(event.metaKey) !== wantsMeta) return false
  if (Boolean(event.ctrlKey) !== wantsCtrl) return false
  if (Boolean(event.shiftKey) !== Boolean(binding.shift)) return false
  if (Boolean(event.altKey) !== Boolean(binding.alt)) return false

  const key = normalizeKey(event.key)
  return key === binding.key
}

function collectIframesDeep(root: ParentNode): Array<HTMLIFrameElement> {
  const visited = new Set<ParentNode>()
  const stack: Array<ParentNode> = [root]
  const iframes: Array<HTMLIFrameElement> = []

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || visited.has(node)) continue
    visited.add(node)

    try {
      const foundIframes = Array.from(node.querySelectorAll('iframe'))
      iframes.push(...foundIframes)
      for (const el of Array.from(node.querySelectorAll('*'))) {
        const shadowRoot = (el as any).shadowRoot as ShadowRoot | undefined
        if (shadowRoot) stack.push(shadowRoot)
      }

      // Traverse into iframe documents when same-origin.
      for (const iframe of foundIframes) {
        try {
          const doc = iframe.contentDocument
          if (doc) stack.push(doc)
        } catch {
          // ignore cross-origin iframe documents
        }
      }
    } catch {
      // ignore unexpected DOM traversal errors
    }
  }

  return iframes
}

export function useKeybindings(
  bindings: Array<Keybinding>,
  options?: { enabled?: boolean; includeIframes?: boolean },
) {
  const enabled = options?.enabled ?? true
  const includeIframes = options?.includeIframes ?? false
  const isMac = React.useMemo(() => isMacPlatform(), [])
  const bindingsRef = React.useRef<Array<Keybinding>>(bindings)

  React.useEffect(() => {
    bindingsRef.current = bindings
  }, [bindings])

  React.useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return

    const handler = (event: KeyboardEvent) => {
      if ((event as any).isComposing) return

      const activeElement = document.activeElement
      const focusKind = focusKindFromTarget(event.target)

      for (const binding of bindingsRef.current) {
        if (event.defaultPrevented && !binding.allowWhenDefaultPrevented)
          continue
        const parsed = parseKeybinding(binding.keys)
        if (!parsed) continue
        if (binding.ignoreRepeat !== false && event.repeat) continue
        if (!binding.allowInInput && focusKind !== 'other') continue
        if (binding.when && !binding.when({ activeElement, focusKind }))
          continue
        if (!matchesKeybinding(event, parsed, isMac)) continue

        if (binding.preventDefault !== false) event.preventDefault()
        if (binding.stopPropagation) event.stopPropagation()
        binding.handler({
          command: binding.command,
          keys: binding.keys,
          event,
          activeElement,
          focusKind,
        })
        return
      }
    }

    const attached = new Set<EventTarget>()

    const getTargets = () => {
      const targets = new Set<EventTarget>()
      targets.add(window)
      if (!includeIframes) return targets

      const iframes = collectIframesDeep(document)
      for (const iframe of iframes) {
        try {
          const w = iframe.contentWindow
          if (w) targets.add(w)
          const doc = iframe.contentDocument
          if (doc) targets.add(doc)
        } catch {
          // ignore cross-origin iframes
        }
      }

      return targets
    }

    const syncTargets = () => {
      console.log('syncTargets')
      const targets = getTargets()
      for (const w of attached) {
        if (!targets.has(w)) {
          ;(w as any).removeEventListener('keydown', handler, true)
          attached.delete(w)
        }
      }
      for (const w of targets) {
        if (!attached.has(w)) {
          ;(w as any).addEventListener('keydown', handler, true)
          attached.add(w)
        }
      }
    }

    syncTargets()

    const observer = includeIframes
      ? new MutationObserver(() => syncTargets())
      : null
    if (observer) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      })
    }

    const onFocusIn = includeIframes ? () => syncTargets() : null
    const onPointerDown = includeIframes ? () => syncTargets() : null
    if (onFocusIn) document.addEventListener('focusin', onFocusIn, true)
    if (onPointerDown)
      document.addEventListener('pointerdown', onPointerDown, true)

    return () => {
      observer?.disconnect()
      if (onFocusIn) document.removeEventListener('focusin', onFocusIn, true)
      if (onPointerDown)
        document.removeEventListener('pointerdown', onPointerDown, true)
      for (const w of attached) {
        ;(w as any).removeEventListener('keydown', handler, true)
      }
      attached.clear()
    }
  }, [enabled, includeIframes, isMac])
}
