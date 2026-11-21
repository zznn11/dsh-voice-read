/**
 * Host half of dsh-voice-read: one authenticated exact route that turns a
 * finished assistant reply into speech through the DeepSeek TTS API.
 *
 * The browser half posts a text (GET query for short replies, JSON body for
 * long ones) and gets back the upstream `audio/wav` bytes. Authentication is
 * the composition's browser fence: `ctx.connection.requestRejection()` applies
 * the same Host/Origin and signed-cookie checks as the `/api` bridge, so an
 * unauthenticated caller never reaches the API key or the upstream service.
 *
 * The API key is re-read on every request and never cached outside the request
 * (and never logged). It comes from `apiKeyPath` (a single line of plain text,
 * default `~/.dsh/voice/api-key.txt`) and falls back to the `DEEPSEEK_API_KEY`
 * environment variable only when that file yields nothing. Markdown, code
 * fences, bracket markers such as `[表情: ...]`, and run-of-whitespace are
 * stripped before synthesis; the text is capped so one click cannot run up an
 * unbounded bill.
 *
 * Both tunables are exposed through the plugin's Cordis `Config`, so a user
 * changes the voice or the key location in `cordis.patch.yml` instead of
 * editing this file. The schema import is optional: a profile whose resolver
 * cannot supply Schemastery still loads the plugin, with raw config values.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis function-plugin name. */
export const name = 'dsh-voice-read'

/** Route carrier plus the trust fence that guards it. */
export const inject = ['webServer', 'connection']

/** Absolute pathname, no trailing slash (WebRoute contract). */
const ROUTE_PATH = '/dsh-voice-read/tts'
const TTS_ENDPOINT = 'https://api.deepseek.com/v1/tools/tts'
const SPEECH_FORMAT = 'wav'

/** Voices the TTS service accepts: `tide` is male, `stella` is female. */
export const VOICE_IDS = ['tide', 'stella']

/** Voice used when the config is absent, blank, or not in `VOICE_IDS`. */
export const DEFAULT_VOICE_ID = 'tide'

/** Default location of the single-line API key file, on any machine. */
export const DEFAULT_API_KEY_PATH = join(homedir(), '.dsh', 'voice', 'api-key.txt')

/** Environment variable consulted only when the key file yields nothing. */
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Cost gate: one utterance never exceeds this many characters. */
export const MAX_SPEECH_CHARS = 2000

/** POST bodies are tiny JSON objects; anything larger is hostile. */
const MAX_POST_BODY_BYTES = 256 * 1024
const UPSTREAM_TIMEOUT_MS = 120_000

/**
 * Optional Cordis config schema. `@deepseek-ai/schemastery` ships with DSH and
 * is declared as a peer dependency, so a profile resolves it; when it cannot be
 * loaded the export stays `undefined`, Cordis passes the raw `config` through,
 * and the defaults below still keep the plugin working.
 */
const schemaModule = await import('@deepseek-ai/schemastery').catch(() => undefined)
const Schema = schemaModule?.default

export const Config = Schema?.object({
  voiceId: Schema.union(VOICE_IDS)
    .default(DEFAULT_VOICE_ID)
    .description('TTS 音色。tide 是男声，stella 是女声。'),
  apiKeyPath: Schema.string()
    .default(DEFAULT_API_KEY_PATH)
    .description(
      `API key 文件路径（单行纯文本）。支持 ~、$HOME、\${HOME} 开头；`
      + `文件读不到或为空时退回环境变量 ${API_KEY_ENV}。`,
    ),
})

/** Trim to a character budget without splitting a surrogate pair. */
function truncateChars(text, limit) {
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

/**
 * Reduce model Markdown to speakable plain text.
 * Fenced code blocks and images are dropped, link text is kept, list/heading
 * markers and emphasis disappear, `[表情: ...]`-style markers are removed, and
 * every whitespace run becomes one space.
 * @param {unknown} input - raw reply text (or HTML-ish text from the page).
 * @returns {string} cleaned text, not yet truncated.
 */
export function cleanForSpeech(input) {
  let text = typeof input === 'string' ? input : String(input ?? '')
  text = text.replace(/\r\n?/g, '\n')
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, ' ')
  text = text.replace(/^\s{0,3}>\s?/gm, ' ')
  text = text.replace(/^\s*[-*+]\s+/gm, ' ')
  text = text.replace(/^\s*\d+[.)]\s+/gm, ' ')
  text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, ' ')
  text = text.replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/(\*|_)(.*?)\1/g, '$2')
  text = text.replace(/~~(.*?)~~/g, '$1')
  text = text.replace(/<[^>]+>/g, ' ')
  text = text.replace(/\[[^\]\n]{1,60}\]/g, ' ')
  text = text.replace(/[*_~`>#|]+/g, ' ')
  // Control glyphs of the button itself, should one ever reach the text.
  text = text.replace(/[▶■⚠]/g, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

/** The one text that may reach the paid endpoint: cleaned, then cost-gated. */
export function speechOf(input) {
  return truncateChars(cleanForSpeech(input), MAX_SPEECH_CHARS)
}

/** A configured value, unwrapped if it happens to be a volatile reference. */
function plain(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** `voiceId` narrowed to a value the service accepts. */
export function normalizeVoiceId(value) {
  const candidate = plain(value)
  return VOICE_IDS.includes(candidate) ? candidate : DEFAULT_VOICE_ID
}

/**
 * Expand the leading home shortcuts a user may write in `apiKeyPath`.
 * A blank value keeps the per-user default so a copied config still works on
 * somebody else's machine.
 */
export function resolveKeyPath(value) {
  const raw = plain(value)
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (trimmed === '') return DEFAULT_API_KEY_PATH
  if (trimmed === '~') return homedir()
  if (trimmed === '$HOME' || trimmed === '${HOME}') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  if (trimmed.startsWith('$HOME/') || trimmed.startsWith('$HOME\\')) return join(homedir(), trimmed.slice(6))
  if (trimmed.startsWith('${HOME}/') || trimmed.startsWith('${HOME}\\')) return join(homedir(), trimmed.slice(8))
  return trimmed
}

/** Read the key file fresh; returns '' when the file exists but holds no line. */
async function readKeyFile(path) {
  const raw = await readFile(path, 'utf8')
  const firstLine = raw.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)
  return firstLine ?? ''
}

/** The environment fallback, trimmed; '' when unset or blank. */
function keyFromEnvironment() {
  const value = process.env[API_KEY_ENV]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * JSON response carrying no cacheable state.
 * Messages name files and variables, never the key itself.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 naming the methods this route accepts. */
function sendMethodNotAllowed(res) {
  res.statusCode = 405
  res.setHeader('allow', 'GET, POST')
  res.setHeader('cache-control', 'no-store')
  res.end()
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_POST_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Abort the upstream call rather than hold a click open forever. */
function timeoutSignal() {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : undefined
}

/** Register the TTS route behind the browser trust fence. */
export function apply(ctx, config) {
  /** Activation config is the fallback for a config read that is unavailable. */
  const activated = config !== null && typeof config === 'object' ? config : {}

  /**
   * Current configuration for this request. Cordis keeps `effectiveConfig`
   * current across retained updates, so a reloaded voice or key path applies to
   * the next click without restarting the plugin.
   */
  const currentConfig = () => {
    try {
      const live = ctx?.fiber?.effectiveConfig
      if (live !== null && typeof live === 'object') return live
    } catch {
      // A fiber that is unloading or absent: keep the activation values.
    }
    return activated
  }

  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET' && req.method !== 'POST') {
        sendMethodNotAllowed(res)
        return
      }

      let requested = ''
      if (req.method === 'GET') {
        const url = new URL(String(req.url), 'http://localhost')
        requested = url.searchParams.get('text') ?? ''
      } else {
        const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
        if (essence !== 'application/json') {
          sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
          return
        }
        let body
        try {
          body = await readBoundedBody(req)
        } catch {
          sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
          return
        }
        if (body === null) {
          sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
          return
        }
        try {
          const parsed = JSON.parse(body)
          if (typeof parsed?.text === 'string') requested = parsed.text
        } catch {
          // Falls through to the empty-text refusal below.
        }
      }

      const speech = speechOf(requested)
      if (speech === '') {
        sendJson(res, 400, { code: 'empty-text', message: 'no speakable text in this reply' })
        return
      }

      const settings = currentConfig()
      const voiceId = normalizeVoiceId(settings.voiceId)
      const keyPath = resolveKeyPath(settings.apiKeyPath)

      let fileKey = ''
      let fileError = false
      try {
        fileKey = await readKeyFile(keyPath)
      } catch {
        fileError = true
      }
      const key = fileKey === '' ? keyFromEnvironment() : fileKey
      if (key === '') {
        if (fileError) {
          sendJson(res, 500, {
            code: 'key-unreadable',
            message: `cannot read the TTS api key at ${keyPath}, and ${API_KEY_ENV} is not set`,
          })
          return
        }
        sendJson(res, 500, {
          code: 'key-empty',
          message: `the TTS api key file is empty: ${keyPath} (or set ${API_KEY_ENV})`,
        })
        return
      }

      // UTF-8 bytes matter: a JS string sent as a latin-1 body makes the
      // service answer 400 "No readable text".
      const payload = Buffer.from(
        JSON.stringify({ text: speech, voice_id: voiceId, format: SPEECH_FORMAT }),
        'utf8',
      )
      let upstream
      try {
        upstream = await fetch(TTS_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: payload,
          signal: timeoutSignal(),
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, { code: 'tts-unreachable', message: `deepseek tts request failed: ${detail}` })
        return
      }

      if (upstream.status !== 200) {
        // Pass the upstream status and error body through unchanged.
        let bytes
        try {
          bytes = Buffer.from(await upstream.arrayBuffer())
        } catch {
          bytes = Buffer.alloc(0)
        }
        res.statusCode = upstream.status
        res.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(bytes)
        return
      }

      let audio
      try {
        audio = Buffer.from(await upstream.arrayBuffer())
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, { code: 'tts-stream-failed', message: `deepseek tts stream failed: ${detail}` })
        return
      }
      if (audio.byteLength === 0) {
        sendJson(res, 502, { code: 'tts-empty', message: 'deepseek tts returned no audio' })
        return
      }

      res.statusCode = 200
      res.setHeader('content-type', 'audio/wav')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-length', String(audio.byteLength))
      res.end(audio)
    },
  }), `dsh-voice-read: GET|POST ${ROUTE_PATH}`)
}
