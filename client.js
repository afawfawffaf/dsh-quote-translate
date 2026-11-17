/**
 * Translate the selected message text into Simplified Chinese.
 *
 * The Chat text-interaction slot is `keyed` and renders only the single entry
 * whose key matches the winning interaction id, so a second action cannot share
 * it with the shipped Quote button. This plugin therefore owns its own overlay:
 * it watches the document selection, anchors a button beside the selection, and
 * leaves the Quote surface untouched.
 *
 * This bundle has no Host half: the DSH desktop deployment resolves its packages
 * from inside `app.asar`, which an installed workspace bundle cannot import. The
 * browser calls the same anonymous Microsoft Edge endpoint the shipped translator
 * service uses, after verifying it allows cross-origin use.
 *
 * Selection text leaves this machine for that endpoint. The plugin never modifies
 * the message, the draft, or the Session log.
 */

/** Anonymous endpoint; CORS is open (`Access-Control-Allow-Origin: *`). */
const ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'

/** Fixed by this plugin's contract: every request targets Simplified Chinese. */
const TARGET_LANGUAGE = 'zh-Hans'

/** Upper bound for one request; longer selections are split at safe boundaries. */
const CHUNK_CHARS = 1800

/** Abort a request the endpoint never answers. */
const REQUEST_TIMEOUT_MS = 20000

/** Only text inside rendered transcript content is offered for translation. */
const SOURCE_SELECTOR = '[data-text-interaction-source]'

/** The shipped Quote button; this overlay must never cover it. */
const QUOTE_BUTTON_SELECTOR = '[data-text-interaction-surface]'

/**
 * Split text into request-sized chunks without breaking surrogate pairs.
 *
 * @param text - the complete selection.
 * @returns ordered chunks whose concatenation preserves the original text.
 */
function splitText(text) {
  if (text.length <= CHUNK_CHARS) return [text]

  const chunks = []
  let rest = text
  while (rest.length > CHUNK_CHARS) {
    const window = rest.slice(0, CHUNK_CHARS)
    // Prefer a paragraph break, then a line break, then a space, then a hard cut.
    let cut = window.lastIndexOf('\n\n')
    if (cut < CHUNK_CHARS * 0.5) cut = window.lastIndexOf('\n')
    if (cut < CHUNK_CHARS * 0.5) cut = window.lastIndexOf(' ')
    if (cut < CHUNK_CHARS * 0.5) cut = CHUNK_CHARS
    // Never split a UTF-16 surrogate pair.
    const code = rest.charCodeAt(cut - 1)
    if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1
    if (cut <= 0) cut = CHUNK_CHARS
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/**
 * Translate one chunk through the anonymous endpoint.
 *
 * @param chunk - text within the request limit.
 * @param signal - caller cancellation, combined with the request timeout.
 * @returns translated text.
 */
async function translateChunk(chunk, signal) {
  const url = new URL(ENDPOINT)
  url.searchParams.set('to', TARGET_LANGUAGE)
  url.searchParams.set('isEnterpriseClient', 'false')

  const combined = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([chunk]),
    signal: combined,
  })
  if (!response.ok) throw new Error(`翻译服务返回 HTTP ${response.status}`)

  const payload = await response.json()
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('翻译服务返回了无法识别的响应')
  }
  // One request carries one string, so the reply holds one object.
  const translated = payload[0]?.translations?.[0]?.text
  if (typeof translated !== 'string') throw new Error('翻译服务返回了无法识别的响应')
  return translated
}

/**
 * Translate a complete selection, preserving chunk order.
 *
 * @param text - the complete selected text.
 * @param signal - caller cancellation.
 * @returns the translated text.
 */
async function translate(text, signal) {
  const parts = []
  for (const chunk of splitText(text)) {
    parts.push(chunk.trim() === '' ? chunk : await translateChunk(chunk, signal))
  }
  return parts.join('')
}

window.__ModuleLoader__.load({
  id: '@local/dsh-quote-translate',
  factory: (require) => {
    const React = require('react')
    const JSX = require('react/jsx-runtime')

    const NS = 'quoteTranslate'

    // -------------------------------------------------------------------
    // Styles
    // -------------------------------------------------------------------

    // The overlay is fixed-position so it never participates in the chat
    // layout. It offsets itself from the Quote button when that button is
    // already present for the same selection.
    const CSS = `
.QTq_action{position:fixed;z-index:2147482999;corner-shape:round;background:var(--dsw-alias-button-floating-fill);--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);cursor:pointer;border:none;border-radius:999px;padding:5px 10px;white-space:nowrap}
.QTq_action:focus-visible{background:var(--dsw-alias-button-floating-hover)}
.QTq_action:disabled{opacity:.55;cursor:default}
@media (hover:hover){.QTq_action:hover:not(:disabled){background:var(--dsw-alias-button-floating-hover)}}
.QTq_panel{position:fixed;z-index:2147483000;min-width:260px;max-width:min(520px,calc(100vw - 32px));max-height:min(400px,calc(100vh - 32px));overflow:auto;background:var(--dsw-alias-button-floating-fill);--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel);border:1px solid var(--dsw-alias-border-l3);border-radius:12px;padding:12px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}
.QTq_panel[data-dragging]{user-select:none}
.QTq_head{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:8px;cursor:grab;touch-action:none}
.QTq_panel[data-dragging] .QTq_head{cursor:grabbing}
.QTq_title{font-weight:600;font-size:12px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.QTq_actions{display:flex;gap:6px}
.QTq_small{border:none;background:transparent;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));cursor:pointer;font:var(--dsw-font-xs-13);padding:2px 6px;border-radius:6px}
.QTq_small:hover{background:var(--dsw-alias-button-floating-hover)}
.QTq_body{white-space:pre-wrap;word-break:break-word;line-height:1.6}
.QTq_error{color:var(--dsw-alias-state-error-primary,inherit);line-height:1.6;white-space:pre-wrap}
`

    let styleTag = null
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (styleTag !== null && styleTag.isConnected) return
      styleTag = document.createElement('style')
      styleTag.dataset.plugin = '@local/dsh-quote-translate'
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

    // -------------------------------------------------------------------
    // Geometry
    // -------------------------------------------------------------------

    /**
     * Read the quote button's rectangle when the host is showing it.
     *
     * @returns the button rectangle, or null when it is absent or hidden.
     */
    function quoteButtonRect() {
      const surface = document.querySelector(QUOTE_BUTTON_SELECTOR)
      if (surface === null) return null
      if (surface.getAttribute('aria-hidden') === 'true') return null
      const button = surface.firstElementChild
      if (button === null) return null
      const rect = button.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return rect
    }

    /**
     * Position the translate button beside the selection, clear of the Quote
     * button and inside the viewport.
     *
     * @param selectionRect - viewport rectangle of the selection.
     * @returns fixed-position coordinates.
     */
    function actionPosition(selectionRect) {
      const margin = 8
      const gap = 6
      const quote = quoteButtonRect()

      // Sit to the right of the Quote button when it is on screen, so the two
      // never overlap; otherwise anchor directly to the selection.
      let left
      let top
      if (quote !== null) {
        left = quote.right + gap
        top = quote.top
      } else {
        left = selectionRect.right + gap
        top = selectionRect.top - 34
        if (top < margin) top = selectionRect.bottom + gap
      }

      // Keep the button inside the viewport; fall back to the left of the
      // selection when there is no room on the right.
      if (left + 90 > window.innerWidth - margin) {
        left = quote !== null ? quote.left - 90 - gap : selectionRect.left - 90 - gap
      }
      left = Math.max(margin, Math.min(left, window.innerWidth - 90 - margin))
      top = Math.max(margin, Math.min(top, window.innerHeight - 34 - margin))
      return { left: `${left}px`, top: `${top}px` }
    }

    /**
     * Place the translation panel near the button but inside the viewport.
     *
     * @param button - viewport rectangle of the translate button.
     * @returns fixed-position styles.
     */
    function panelPosition(button) {
      const margin = 12
      const width = Math.min(520, Math.max(280, 320))
      const left = Math.min(
        Math.max(margin, button.left),
        Math.max(margin, window.innerWidth - width - margin),
      )
      const below = button.bottom + 8
      const spaceBelow = window.innerHeight - below - margin
      const top = spaceBelow > 220 ? below : Math.max(margin, button.top - 232)
      return { left: `${left}px`, top: `${top}px`, width: `${width}px` }
    }

    // -------------------------------------------------------------------
    // Panel
    // -------------------------------------------------------------------

    /**
     * Floating card for one translation; the source text is never rewritten.
     *
     * @param props - anchor rectangle, request state, and dismissal callback.
     */
    function TranslatePanel({ anchor, state, onClose }) {
      const [copied, setCopied] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      const ref = React.useRef(null)
      // `position` is the committed placement; `offset` is the drag translation
      // applied on top of it so the panel keeps its anchor-relative spot.
      const [position, setPosition] = React.useState(() => panelPosition(anchor))
      const [offset, setOffset] = React.useState({ x: 0, y: 0 })
      const drag = React.useRef(null)

      React.useLayoutEffect(() => {
        setPosition(panelPosition(anchor))
      }, [anchor])

      React.useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
      }, [copied])

      React.useEffect(() => {
        if (!dragging) return undefined
        function onMove(event) {
          const current = drag.current
          if (current === null) return
          const nextX = current.x + (event.clientX - current.pointerX)
          const nextY = current.y + (event.clientY - current.pointerY)
          // Keep a sliver of the panel on screen so it can always be grabbed.
          const maxX = window.innerWidth - 80
          const maxY = window.innerHeight - 40
          setOffset({
            x: Math.max(-current.baseLeft + 8, Math.min(nextX, maxX - current.baseLeft)),
            y: Math.max(-current.baseTop + 8, Math.min(nextY, maxY - current.baseTop)),
          })
        }
        function onUp() {
          setDragging(false)
          drag.current = null
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [dragging])

      React.useEffect(() => {
        function onKeyDown(event) {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          onClose()
        }
        function onPointerDown(event) {
          if (ref.current !== null && !ref.current.contains(event.target)) onClose()
        }
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [onClose])

      const baseLeft = Number.parseFloat(position.left) || 0
      const baseTop = Number.parseFloat(position.top) || 0
      const style = {
        ...position,
        left: `${baseLeft + offset.x}px`,
        top: `${baseTop + offset.y}px`,
      }

      const startDrag = (event) => {
        // Buttons inside the header keep their own behaviour.
        if (event.target instanceof Element && event.target.closest('button') !== null) return
        event.preventDefault()
        drag.current = {
          pointerX: event.clientX,
          pointerY: event.clientY,
          x: offset.x,
          y: offset.y,
          baseLeft,
          baseTop,
        }
        setDragging(true)
      }

      const text = state.kind === 'done' ? state.text : ''
      const copy = async () => {
        if (text === '') return
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
        } catch {
          setCopied(false)
        }
      }

      const body =
        state.kind === 'loading'
          ? '翻译中…'
          : state.kind === 'error'
            ? state.message
            : state.text

      return JSX.jsx('div', {
        ref,
        className: 'QTq_panel',
        role: 'dialog',
        'aria-label': '译文',
        style,
        'data-dragging': dragging ? '' : undefined,
        children: [
          JSX.jsx('div', {
            key: 'head',
            className: 'QTq_head',
            onPointerDown: startDrag,
            children: [
              JSX.jsx('span', { key: 'title', className: 'QTq_title', children: '译文 · 简体中文' }),
              JSX.jsx('span', {
                key: 'actions',
                className: 'QTq_actions',
                children: [
                  state.kind === 'done'
                    ? JSX.jsx('button', {
                        key: 'copy',
                        type: 'button',
                        className: 'QTq_small',
                        onClick: copy,
                        children: copied ? '已复制' : '复制',
                      })
                    : null,
                  JSX.jsx('button', {
                    key: 'close',
                    type: 'button',
                    className: 'QTq_small',
                    onClick: onClose,
                    'aria-label': '关闭',
                    children: '✕',
                  }),
                ],
              }),
            ],
          }),
          JSX.jsx('div', {
            key: 'body',
            className: state.kind === 'error' ? 'QTq_error' : 'QTq_body',
            children: body,
          }),
        ],
      })
    }

    // -------------------------------------------------------------------
    // Selection overlay
    // -------------------------------------------------------------------

    /**
     * Read the current selection when it lies inside transcript content.
     *
     * @returns the selected text and its viewport rectangle, or null.
     */
    function readTranscriptSelection() {
      const selection = document.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
      const text = selection.toString()
      if (text.trim() === '') return null

      const range = selection.getRangeAt(0)
      const node = range.commonAncestorContainer
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
      if (element === null || element.closest(SOURCE_SELECTOR) === null) return null

      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0)
      const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null

      // A selection inside an editable field belongs to the composer, not to a
      // transcript message, so the overlay stays out of the way there.
      if (element.closest('[contenteditable="true"], input, textarea') !== null) return null

      return { text, rect }
    }

    /**
     * Overlay that offers translation for the current transcript selection.
     *
     * It renders outside the Chat slot system, so the shipped Quote action keeps
     * its own surface and neither plugin competes for the keyed slot entry.
     */
    function SelectionOverlay({ t }) {
      const [target, setTarget] = React.useState(null)
      const [state, setState] = React.useState(null)
      const [buttonRect, setButtonRect] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      // A click collapses the selection, so the captured selection must outlive it
      // until the panel closes; otherwise the button and panel would unmount.
      const pinned = React.useRef(null)
      const inflight = React.useRef(null)

      React.useEffect(
        () => () => {
          inflight.current?.abort()
          inflight.current = null
        },
        [],
      )

      const close = React.useCallback(() => {
        inflight.current?.abort()
        inflight.current = null
        pinned.current = null
        setBusy(false)
        setState(null)
        setTarget(null)
      }, [])

      // Track selections and reposition while the page scrolls or resizes. The
      // Quote surface mounts asynchronously, so polling re-places the button once
      // that surface appears, keeping the two from overlapping.
      React.useEffect(() => {
        let frame = 0
        const schedule = () => {
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            if (pinned.current !== null) return
            const selection = readTranscriptSelection()
            if (selection === null) {
              setTarget(null)
              return
            }
            setTarget({ text: selection.text, rect: selection.rect })
          })
        }
        const onSelectionChange = () => schedule()
        document.addEventListener('selectionchange', onSelectionChange)
        document.addEventListener('pointerup', onSelectionChange, true)
        window.addEventListener('scroll', onSelectionChange, true)
        window.addEventListener('resize', onSelectionChange)
        const timer = setInterval(schedule, 400)
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          clearInterval(timer)
          document.removeEventListener('selectionchange', onSelectionChange)
          document.removeEventListener('pointerup', onSelectionChange, true)
          window.removeEventListener('scroll', onSelectionChange, true)
          window.removeEventListener('resize', onSelectionChange)
        }
      }, [])

      if (target === null) return null

      const position = actionPosition(target.rect)

      const run = async () => {
        const text = target.text
        if (text.trim() === '') return
        // Pin the captured selection before the click clears it in the document.
        pinned.current = target
        const button = document.querySelector('.QTq_action')
        if (button !== null) setButtonRect(button.getBoundingClientRect())
        setState({ kind: 'loading' })
        setBusy(true)
        const controller = new AbortController()
        inflight.current = controller
        try {
          const translated = await translate(text, controller.signal)
          if (controller.signal.aborted) return
          setState({ kind: 'done', text: translated })
        } catch (error) {
          if (controller.signal.aborted) return
          setState({ kind: 'error', message: describeError(error, t) })
        } finally {
          if (inflight.current === controller) {
            inflight.current = null
            setBusy(false)
          }
        }
      }

      return JSX.jsxs(React.Fragment, {
        children: [
          JSX.jsx('button', {
            key: 'action',
            type: 'button',
            className: 'QTq_action',
            style: position,
            'aria-label': t('translate.add'),
            disabled: busy,
            onPointerDown: (event) => {
              // Prevent the press from clearing the selection before the click.
              event.preventDefault()
              event.stopPropagation()
            },
            onClick: (event) => {
              event.stopPropagation()
              void run()
            },
            children: t('translate.add'),
          }),
          state !== null && buttonRect !== null
            ? JSX.jsx(TranslatePanel, { key: 'panel', anchor: buttonRect, state, onClose: close })
            : null,
        ],
      })
    }

    /**
     * Turn a failure into a short user-facing sentence.
     *
     * @param error - rejection from the request.
     * @param t - locale lookup.
     * @returns message shown in the panel.
     */
    function describeError(error, t) {
      if (error instanceof DOMException) {
        if (error.name === 'TimeoutError') return t('translate.timeout')
        if (error.name === 'AbortError') return t('translate.cancelled')
      }
      const message = error instanceof Error ? error.message : String(error)
      return message === '' ? t('translate.failed') : `${t('translate.failed')}：${message}`
    }

    // -------------------------------------------------------------------
    // Locale
    // -------------------------------------------------------------------

    const zh = {
      'translate.add': '翻译',
      'translate.failed': '翻译失败',
      'translate.cancelled': '已取消翻译',
      'translate.timeout': '翻译超时，请重试',
    }
    const en = {
      'translate.add': 'Translate',
      'translate.failed': 'Translation failed',
      'translate.cancelled': 'Translation cancelled',
      'translate.timeout': 'Translation timed out, please retry',
    }

    // -------------------------------------------------------------------
    // Plugin
    // -------------------------------------------------------------------

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => () => {
        if (styleTag !== null && styleTag.isConnected) styleTag.remove()
        styleTag = null
      }, 'quote-translate: styles')

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'quote-translate: dictionaries')

      // `shell.overlay` is a list slot that renders every registered entry, so it
      // can host an overlay the keyed text-interaction slot cannot.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'quote-translate',
            locale: NS,
          },
          SelectionOverlay,
        ),
      )
    }

    return { inject, apply }
  },
})
