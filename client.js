/**
 * Browser half of dsh-voice-read: one play button in the finalized assistant
 * message's action strip. A click reads that reply's visible text from the
 * surrounding Chat node and asks the Host route for WAV speech, which an
 * ordinary `Audio` element plays. Nothing is read automatically.
 *
 * The WAV bytes of the last 20 utterances stay in a bounded in-memory cache,
 * so replaying a message costs nothing; every playback owns one object URL and
 * revokes it when playback stops, fails, or the button unmounts.
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-read',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE_PATH = '/dsh-voice-read/tts'
    const MAX_SPEECH_CHARS = 2000
    /** Above this URL length the Host is asked with a JSON body instead. */
    const MAX_GET_URL_CHARS = 6000
    const CACHE_LIMIT = 20

    const BUILD = 'v5'
    const LABEL_IDLE = '朗读这条回复'
    const LABEL_LOADING = '正在合成语音'
    const LABEL_PLAYING = '停止朗读'
    const LABEL_ERROR = '朗读失败'

    /** text -> WAV Blob, oldest insertion evicted first. */
    const audioCache = new Map()

    function cacheGet(text) {
      const hit = audioCache.get(text)
      if (hit !== undefined) {
        audioCache.delete(text)
        audioCache.set(text, hit)
      }
      return hit
    }

    function cacheSet(text, blob) {
      if (audioCache.has(text)) audioCache.delete(text)
      audioCache.set(text, blob)
      while (audioCache.size > CACHE_LIMIT) audioCache.delete(audioCache.keys().next().value)
    }

    /** Fetch WAV bytes; a non-200 answer becomes a readable error. */
    async function fetchSpeech(text) {
      const query = `${ROUTE_PATH}?text=${encodeURIComponent(text)}`
      const response = query.length <= MAX_GET_URL_CHARS
        ? await fetch(query)
        : await fetch(ROUTE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ text }),
        })
      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.text()).slice(0, 300)
        } catch {
          // The status alone still explains the failure.
        }
        const hint = response.status === 401 || response.status === 403 ? '（未登录或登录已过期，刷新页面再试）' : ''
        throw new Error(`${response.status}${hint}${detail === '' ? '' : `: ${detail}`}`)
      }
      return await response.blob()
    }

    /**
     * Reply prose for the message this button belongs to.
     *
     * The button sits in the Assistant action strip, which lives in the same row
     * as the reply text — but the exact nesting depth differs between work-details
     * modes, and Chat's own prose attribute is not always present. So walk outward
     * from the strip and stop at the first ancestor that (a) still contains only
     * this one action strip, i.e. has not swallowed a neighbouring message, and
     * (b) has text once the strip's own chrome is removed.
     */
    function replyTextOf(button) {
      const strip = button.closest('[data-slot="conversation.chat.assistant-actions"]')
      let node = strip ? strip.parentElement : button.parentElement
      for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
        const strips = node.querySelectorAll('[data-slot="conversation.chat.assistant-actions"]').length
        if (strips > 1) break
        const cleaned = cleanSpeech(proseText(node, strip))
        if (cleaned.length >= 4) return cleaned
      }
      // The reply may be rendered before the footer that owns this strip.
      if (strip) {
        let anchor = strip
        for (let level = 0; anchor && level < 6; level += 1, anchor = anchor.parentElement) {
          let sibling = anchor.previousElementSibling
          for (let step = 0; sibling && step < 8; step += 1, sibling = sibling.previousElementSibling) {
            const cleaned = cleanSpeech(proseText(sibling, null))
            if (cleaned.length >= 4) return cleaned
          }
        }
      }
      return ''
    }

    /**
     * Prose of `root` with code, the action strip, and other chrome left out.
     *
     * A rendered code fence has no ``` markers left in `innerText`, so markdown
     * cleanup on the Host cannot recognise it — the code has to be skipped here,
     * by element, before the text is assembled.
     */
    function proseText(root, strip) {
      const SKIP = ['PRE', 'CODE', 'SCRIPT', 'STYLE', 'SVG', 'BUTTON']
      const BLOCK = ['P', 'DIV', 'LI', 'BR', 'TR', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'UL', 'OL']
      const parts = []
      const walk = (el) => {
        for (const child of el.childNodes) {
          if (child.nodeType === 3) {
            parts.push(child.nodeValue ?? '')
            continue
          }
          if (child.nodeType !== 1) continue
          const tag = String(child.tagName ?? '').toUpperCase()
          if (SKIP.includes(tag)) continue
          if (strip && (child === strip || strip.contains(child))) continue
          const block = BLOCK.includes(tag)
          if (block) parts.push('\n')
          walk(child)
          if (block) parts.push('\n')
        }
      }
      walk(root)
      return parts.join('')
    }

    /** Small fingerprint of the surroundings, shown only when extraction fails. */
    function diagnose(button) {
      const strip = button?.closest?.('[data-slot="conversation.chat.assistant-actions"]')
      if (!strip) return '找不到操作条'
      const parent = strip.parentElement
      const sample = (parent?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
      const prev = strip.previousElementSibling
      const prevSample = (prev?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
      return `父级[${sample}] 前一块[${prevSample}]`
    }

    /** Drop UI chrome, stage directions, and standalone timestamps, then clamp. */
    function cleanSpeech(raw) {
      let text = String(raw ?? '')
      // A line that is only a clock reading is row chrome, never the reply.
      text = text
        .split('\n')
        .filter((line) => !/^\s*\d{1,2}:\d{2}(\s*[AP]M)?\s*$/.test(line))
        .join(' ')
      // Full-width parentheses hold stage directions such as （笑了一下）, not speech.
      text = text.replace(/（[^（）]{1,40}）/g, ' ')
      // Inline code backticks read as noise.
      text = text.replace(/`([^`]{0,80})`/g, '$1')
      text = text.replace(/[▶■⚠…]/g, ' ')
      text = text.replace(/\s+/g, ' ').trim()
      return Array.from(text).slice(0, MAX_SPEECH_CHARS).join('')
    }

    function VoiceRead() {
      const buttonRef = React.useRef(null)
      const audioRef = React.useRef(null)
      const urlRef = React.useRef('')
      const aliveRef = React.useRef(true)
      const [phase, setPhase] = React.useState('idle')
      const [reason, setReason] = React.useState('')

      const releaseUrl = React.useCallback(() => {
        const url = urlRef.current
        urlRef.current = ''
        if (url !== '') URL.revokeObjectURL(url)
      }, [])

      const stop = React.useCallback(() => {
        const audio = audioRef.current
        if (audio) {
          audio.onended = null
          audio.onerror = null
          audio.pause()
          audio.removeAttribute('src')
          try {
            audio.load()
          } catch {
            // Already detached audio: nothing left to reset.
          }
        }
        releaseUrl()
        setPhase('idle')
        setReason('')
      }, [releaseUrl])

      React.useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          const audio = audioRef.current
          if (audio) {
            audio.onended = null
            audio.onerror = null
            audio.pause()
            audio.removeAttribute('src')
          }
          releaseUrl()
        }
      }, [releaseUrl])

      const fail = (message) => {
        if (!aliveRef.current) return
        setPhase('error')
        setReason(message)
      }

      const onClick = async () => {
        if (phase === 'loading') return
        if (phase === 'playing') {
          stop()
          return
        }
        const text = replyTextOf(buttonRef.current)
        if (text === '') {
          fail(`没有取到这条回复的正文（${BUILD} ${diagnose(buttonRef.current)}）`)
          return
        }
        setPhase('loading')
        setReason('')

        let blob = cacheGet(text)
        if (blob === undefined) {
          try {
            blob = await fetchSpeech(text)
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error))
            return
          }
          if (blob.size > 0) cacheSet(text, blob)
        }
        if (!aliveRef.current) return
        if (blob.size === 0) {
          fail('服务端没有返回音频')
          return
        }

        let audio = audioRef.current
        if (!audio) {
          audio = new Audio()
          audio.preload = 'auto'
          audioRef.current = audio
        }
        releaseUrl()
        const url = URL.createObjectURL(blob)
        urlRef.current = url
        audio.onended = () => {
          if (!aliveRef.current) return
          releaseUrl()
          setPhase('idle')
          setReason('')
        }
        audio.onerror = () => {
          if (!aliveRef.current) return
          releaseUrl()
          fail('音频播放失败')
        }
        audio.src = url
        try {
          await audio.play()
        } catch (error) {
          releaseUrl()
          fail(`浏览器拦下了播放：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        if (!aliveRef.current) return
        setPhase('playing')
      }

      const glyph = phase === 'playing' ? '■' : phase === 'loading' ? '…' : phase === 'error' ? '⚠' : '▶'
      const title = phase === 'playing'
        ? LABEL_PLAYING
        : phase === 'loading'
          ? LABEL_LOADING
          : phase === 'error'
            ? `${LABEL_ERROR}${reason === '' ? '' : `：${reason}`}（再点一次重试）`
            : LABEL_IDLE

      return h('button', {
        ref: buttonRef,
        type: 'button',
        'data-voice-read': 'action',
        title,
        'aria-label': title,
        onClick,
        onMouseEnter: event => {
          event.currentTarget.style.background = 'color-mix(in srgb, currentColor 12%, transparent)'
        },
        onMouseLeave: event => {
          event.currentTarget.style.background = 'transparent'
        },
        style: {
          // The host's :focus-visible ring stays untouched: no outline reset here.
          appearance: 'none',
          WebkitAppearance: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          minWidth: '20px',
          height: '20px',
          margin: '0',
          padding: '0 4px',
          border: 'none',
          borderRadius: '4px',
          background: 'transparent',
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: '12px',
          fontWeight: 'inherit',
          lineHeight: '1',
          verticalAlign: 'middle',
          cursor: 'pointer',
          opacity: phase === 'loading' ? '0.55' : '1',
        },
      }, glyph)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // `inject` keeps this entry mounted exactly while ui-conversation hosts
        // the strip; the strip owns the ordering, order 20 lands after feedback.
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'voice-read',
          order: 20,
        }, VoiceRead))
      },
    }
  },
})
