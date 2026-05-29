/**
 * utils/web.ts — 网络工具
 *
 * [K-24] fetchWebPage：抓取 URL，HTML 转纯文本，处理 JS/meta 重定向
 * [K-25] searchDuckDuckGoLite：DuckDuckGo Lite + Sogou 双后备搜索
 *
 * 设计原则：
 * - AbortController 实现超时，不依赖任何外部库
 * - 指数退避重试（最多 2 次），只对 429/5xx 和网络错误重试
 * - HTML 解析只用正则，不引入额外解析库（YAGNI）
 */
import { getErrorCode } from './errors.js'

// ── 类型 ──────────────────────────────────────────────────────────────────

type SearchResult = {
  title: string
  link: string
  snippet: string
  date: string
  display_link: string
}

type SearchProvider = 'duckduckgo-lite' | 'sogou'

// ── 常量 ──────────────────────────────────────────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MiniCode/0.1'
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_RETRIES = 2

// ── 工具函数 ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (!code) return error instanceof Error && error.name === 'AbortError'
  return [
    'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ].includes(code)
}

function formatWebErrorMessage(url: string, error: unknown, timeoutMs: number): string {
  const code = getErrorCode(error)
  if (code) return `request failed (${code}) for ${url}`
  if (error instanceof Error && error.name === 'AbortError') {
    return `request timed out after ${timeoutMs}ms for ${url}`
  }
  if (error instanceof Error && error.message) return `${error.message} (${url})`
  return `request failed for ${url}`
}

/**
 * 带超时和指数退避重试的 fetch 封装。
 */
async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options?: { timeoutMs?: number; maxRetries?: number },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
  const target = typeof url === 'string' ? url : url.toString()

  let lastError: unknown = null
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      clearTimeout(timeout)
      lastResponse = response

      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        await sleep(300 * Math.pow(2, attempt))
        continue
      }
      return response
    } catch (error) {
      clearTimeout(timeout)
      lastError = error
      if (attempt < maxRetries && isRetryableNetworkError(error)) {
        await sleep(300 * Math.pow(2, attempt))
        continue
      }
      throw new Error(formatWebErrorMessage(target, error, timeoutMs))
    }
  }

  if (lastResponse) return lastResponse
  throw new Error(formatWebErrorMessage(target, lastError, timeoutMs))
}

// ── HTML 解析工具 ──────────────────────────────────────────────────────────

function firstMatch(pattern: RegExp, text: string, group = 1): string | null {
  return text.match(pattern)?.[group] ?? null
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gu, '&').replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'").replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
    .replace(/&#x2F;/gu, '/').replace(/&#47;/gu, '/')
    .replace(/&nbsp;/gu, ' ')
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)
  return match ? decodeHtml(stripTags(match[1] ?? '')).trim() : null
}

function extractReadableText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style[\s\S]*?<\/style>/giu, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
}

function extractHtmlRedirectUrl(html: string, baseUrl: string): string | null {
  const raw = decodeHtml((
    firstMatch(/window\.location(?:\.href)?(?:\.replace)?\((['"])(.*?)\1\)/iu, html, 2) ??
    firstMatch(/window\.location(?:\.href)?\s*=\s*(['"])(.*?)\1/iu, html, 2) ??
    firstMatch(
      /<meta[^>]*http-equiv=(['"])refresh\1[^>]*content=(['"])[\s\S]*?url\s*=\s*('?)([^"'>;]+)\3[\s\S]*?\2[^>]*>/iu,
      html,
      4,
    ) ?? ''
  ).trim())
  if (!raw) return null
  try { return new URL(raw, baseUrl).toString() } catch { return null }
}

// ── 搜索结果解析 ───────────────────────────────────────────────────────────

function normalizeDuckDuckGoLink(rawHref: string): string {
  const href = decodeHtml(rawHref).trim()
  if (!href) return ''
  const absolute = href.startsWith('//') ? `https:${href}` : href
  try {
    const url = new URL(absolute)
    const redirect = url.searchParams.get('uddg')
    return redirect ? decodeURIComponent(redirect) : url.toString()
  } catch { return absolute }
}

function parseDuckDuckGoLite(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const matches = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu)]

  for (let i = 0; i < matches.length; i++) {
    const anchorHtml = matches[i]?.[0] ?? ''
    const classValue = firstMatch(/class=(['"])([\s\S]*?)\1/iu, anchorHtml, 2) ?? ''
    if (!/\bresult-link\b/i.test(classValue)) continue

    const rawHref = firstMatch(/href=(['"])([\s\S]*?)\1/iu, anchorHtml, 2) ?? ''
    const title = decodeHtml(stripTags(firstMatch(/<a\b[^>]*>([\s\S]*?)<\/a>/iu, anchorHtml) ?? ''))
    const next = matches[i + 1]
    const block = html.slice(matches[i]?.index ?? 0, next?.index ?? html.length)
    const snippet = decodeHtml(stripTags(
      firstMatch(
        /<td[^>]*class=(['"])[^'"]*\bresult-snippet\b[^'"]*\1[^>]*>\s*([\s\S]*?)\s*<\/td>/iu,
        block,
        2,
      ) ?? '',
    ))
    const displayLink = decodeHtml(stripTags(
      firstMatch(
        /<span[^>]*class=(['"])[^'"]*\blink-text\b[^'"]*\1[^>]*>([\s\S]*?)<\/span>/iu,
        block,
        2,
      ) ?? '',
    ))
    const link = normalizeDuckDuckGoLink(rawHref)
    if (!title || !link) continue
    results.push({ title, link, snippet, date: '', display_link: displayLink })
  }
  return results
}

function parseSogouSearch(html: string): SearchResult[] {
  const matches = [...html.matchAll(/<h3\b[^>]*>\s*([\s\S]*?)<\/h3>/giu)]
  const results: SearchResult[] = []

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    if (!match) continue
    const h3Html = match[0]
    const rawHref = decodeHtml(firstMatch(/href=(['"])([\s\S]*?)\1/iu, h3Html, 2) ?? '')
    const title = decodeHtml(stripTags(firstMatch(/<a\b[^>]*>([\s\S]*?)<\/a>/iu, h3Html, 1) ?? ''))
    const link = rawHref.startsWith('/')
      ? `https://www.sogou.com${rawHref}`
      : rawHref.startsWith('//')
        ? `https:${rawHref}`
        : rawHref
    if (!title || !link) continue

    const next = matches[i + 1]
    const block = html.slice(match.index ?? 0, next?.index ?? html.length)
    const snippet = decodeHtml(stripTags(
      firstMatch(
        /<(div|p)\b[^>]*class=(['"])[^'"]*(fz-mid|str-text-info|text-layout|space-txt)[^'"]*\2[^>]*>([\s\S]*?)<\/\1>/iu,
        block,
        4,
      ) ?? '',
    ))
    let displayLink = ''
    try { displayLink = new URL(link).hostname } catch { displayLink = link }
    results.push({ title, link, snippet, date: '', display_link: displayLink })
  }
  return results
}

function fetchSearchPage(provider: SearchProvider, query: string): Promise<Response> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }
  if (provider === 'duckduckgo-lite') {
    const url = new URL('https://lite.duckduckgo.com/lite/')
    url.searchParams.set('q', query)
    headers['accept-language'] = 'en-US,en;q=0.9'
    return fetchWithRetry(url, { headers })
  }
  // sogou
  const url = new URL('https://www.sogou.com/web')
  url.searchParams.set('query', query)
  headers['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.6'
  return fetchWithRetry(url, { headers })
}

// ── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 搜索网页：DuckDuckGo Lite 优先，失败降级到 Sogou。
 *
 * [K-25] 双后备设计：单一搜索引擎偶发不可用时不影响用户体验。
 */
export async function searchDuckDuckGoLite(options: {
  query: string
  maxResults?: number
}): Promise<{
  organic: SearchResult[]
  base_resp: { status_code: number; status_msg: string; source: string }
}> {
  const maxResults = options.maxResults ?? 5
  const providers: SearchProvider[] = ['duckduckgo-lite', 'sogou']
  const errors: string[] = []

  for (const provider of providers) {
    try {
      const response = await fetchSearchPage(provider, options.query)
      if (!response.ok) {
        errors.push(`${provider}: HTTP ${response.status}`)
        continue
      }
      const html = await response.text()
      const parsed = provider === 'duckduckgo-lite'
        ? parseDuckDuckGoLite(html)
        : parseSogouSearch(html)
      const organic = parsed.slice(0, maxResults)
      if (organic.length > 0) {
        return {
          organic,
          base_resp: { status_code: response.status, status_msg: response.statusText, source: provider },
        }
      }
      errors.push(`${provider}: no results`)
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`所有搜索服务均失败 (${errors.join('; ')})`)
  }
  return {
    organic: [],
    base_resp: { status_code: 200, status_msg: 'OK', source: 'fallback-empty' },
  }
}

/**
 * 抓取网页并提取可读文本内容。
 *
 * [K-24] 处理两种重定向：HTTP 301/302（fetch 自动跟随）和
 * HTML meta refresh / JS window.location（手动检测并再次请求）。
 */
export async function fetchWebPage(options: {
  url: string
  maxChars?: number
}): Promise<{
  url: string
  finalUrl: string
  status: number
  statusText: string
  contentType: string
  title: string | null
  content: string
}> {
  const requestInit: RequestInit = {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  }

  let response = await fetchWithRetry(options.url, requestInit)
  let text = await response.text()
  let contentType = response.headers.get('content-type') ?? ''
  let finalUrl = response.url || options.url

  // 处理 HTML 内嵌重定向
  if (contentType.includes('html')) {
    const redirectUrl = extractHtmlRedirectUrl(text, finalUrl)
    if (redirectUrl && redirectUrl !== finalUrl) {
      response = await fetchWithRetry(redirectUrl, requestInit)
      text = await response.text()
      contentType = response.headers.get('content-type') ?? ''
      finalUrl = response.url || redirectUrl
    }
  }

  const maxChars = options.maxChars ?? 12_000

  if (contentType.includes('html')) {
    return {
      url: options.url,
      finalUrl,
      status: response.status,
      statusText: response.statusText,
      contentType,
      title: extractTitle(text),
      content: extractReadableText(text).slice(0, maxChars),
    }
  }

  return {
    url: options.url,
    finalUrl,
    status: response.status,
    statusText: response.statusText,
    contentType,
    title: null,
    content: text.slice(0, maxChars),
  }
}
