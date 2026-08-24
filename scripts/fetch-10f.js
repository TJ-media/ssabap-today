'use strict'

const { GoogleGenerativeAI } = require('@google/generative-ai')
const fs = require('fs')
const path = require('path')

const MM_SERVER = 'https://meeting.ssafy.com'
// 10층 식단표가 매주 올라오는 채널 (팀/채널 이름은 채널 URL에서 그대로 따옴)
// https://meeting.ssafy.com/s15p20a5/channels/town-square
const MENU_TEAM_NAME = process.env.MM_MENU_TEAM_NAME || 's15p20a5'
const MENU_CHANNEL_NAME = process.env.MM_MENU_CHANNEL_NAME || 'town-square'
const MENU_CHANNEL_URL = `${MM_SERVER}/${MENU_TEAM_NAME}/channels/${MENU_CHANNEL_NAME}`
// 예전에 식단표가 올라오던 스레드의 루트 포스트 (이름 조회가 안 될 때만 쓰는 폴백)
const MENU_THREAD_POST_ID = '1k43iwapofrtbe3a7d66ed9izo'

// town-square처럼 글이 많은 채널에서도 이번 주 식단표에 닿도록 여러 페이지를 훑는다
const POSTS_PER_PAGE = 200
const MAX_POST_PAGES = Number(process.env.MM_MENU_MAX_PAGES ?? 5)
const MAX_POST_AGE_DAYS = Number(process.env.MM_MENU_MAX_POST_AGE_DAYS ?? 28)

const DATA_DIR = path.join(__dirname, '..', 'data-10f')
const LAST_PARSED_FILE = path.join(DATA_DIR, '.last-parsed.json')

function getKSTDateStr() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}

// 오늘자 식단을 확보하지 못했을 때 관리자 웹훅으로 경고 발송
async function sendAlert(text) {
  const url = process.env.MM_ALERT_WEBHOOK_URL
  if (!url) {
    console.warn(`MM_ALERT_WEBHOOK_URL 미설정, 경고 스킵: ${text}`)
    return
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `⚠️ **[ssabap-today] 10층 식단 수집 경고**\n${text}` }),
    })
    if (!res.ok) console.warn(`경고 웹훅 발송 실패: HTTP ${res.status}`)
  } catch (e) {
    console.warn(`경고 웹훅 발송 실패: ${e.message}`)
  }
}

// ── Mattermost API ─────────────────────────────────────────────────────────

async function mmApi(token, apiPath) {
  const res = await fetch(`${MM_SERVER}/api/v4${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const err = new Error(`MM API 실패: ${apiPath} → HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res
}

async function mmLogin() {
  const { login_id, password } = JSON.parse(process.env.MM_LOGIN_JSON)
  const res = await fetch(`${MM_SERVER}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id, password }),
  })
  if (!res.ok) throw new Error(`MM 로그인 실패: HTTP ${res.status}`)
  const token = res.headers.get('Token')
  if (!token) throw new Error('로그인 응답에 토큰 없음')
  return token
}

// 채널 URL의 팀/채널 이름으로 채널 ID를 조회 (기본 경로)
async function resolveChannelIdByName(token) {
  if (!MENU_TEAM_NAME || !MENU_CHANNEL_NAME) return null
  const apiPath = `/teams/name/${encodeURIComponent(MENU_TEAM_NAME)}` +
    `/channels/name/${encodeURIComponent(MENU_CHANNEL_NAME)}`
  try {
    const channel = await (await mmApi(token, apiPath)).json()
    console.log(`식단표 채널 확인: ${MENU_CHANNEL_URL} → ${channel.id}`)
    return channel.id
  } catch (e) {
    console.warn(
      `채널 이름 조회 실패 (${MENU_TEAM_NAME}/${MENU_CHANNEL_NAME}): ${e.message}\n` +
      `→ 이 MM 계정이 해당 팀에 속해 있는지 확인하세요: ${MENU_CHANNEL_URL}`
    )
    return null
  }
}

// 예전 식단표 스레드에서 채널 ID를 역추적 (이름 조회가 실패했을 때만)
async function resolveChannelIdByThread(token) {
  try {
    const post = await (await mmApi(token, `/posts/${MENU_THREAD_POST_ID}`)).json()
    return post.channel_id
  } catch (e) {
    console.warn(`식단표 스레드 조회 실패: ${e.message}`)
    return null
  }
}

// 파일명이 "멀티캠퍼스(10층)_공존식단_26년_8월_2주차.png" 형태라 이름만으로 충분히 구분된다
const MENU_FILE_NAME_RE = /10\s*층|공존\s*식단/

function is10FMenuFile(info) {
  const name = info.name ?? ''
  const isImage =
    (info.mime_type ?? '').startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(name)
  return isImage && MENU_FILE_NAME_RE.test(name)
}

// 포스트 첨부에서 10층 식단표 이미지를 찾음
async function pick10FFile(token, post) {
  if (!post.file_ids?.length) return null
  for (const fileId of post.file_ids) {
    let info
    try {
      info = await (await mmApi(token, `/files/${fileId}/info`)).json()
    } catch {
      continue
    }
    if (is10FMenuFile(info)) return { fileId, fileName: info.name }
  }
  return null
}

// 채널 최신 포스트부터 탐색.
// 본문 문구('식단표 공유')는 채널마다 달라 조건에서 뺐고, 첨부 파일명으로만 판별한다.
async function findLatest10FImage(token, channelId) {
  const cutoff = Date.now() - MAX_POST_AGE_DAYS * 24 * 60 * 60 * 1000

  for (let page = 0; page < MAX_POST_PAGES; page++) {
    let data
    try {
      const res = await mmApi(
        token,
        `/channels/${channelId}/posts?per_page=${POSTS_PER_PAGE}&page=${page}`
      )
      data = await res.json()
    } catch (e) {
      console.warn(`채널 ${channelId} 포스트 조회 실패(page ${page}): ${e.message}`)
      return null
    }

    // order는 최신순 정렬
    const order = data.order ?? []
    if (!order.length) return null

    for (const postId of order) {
      const post = data.posts?.[postId]
      if (!post) continue
      // 너무 오래된 글까지 내려가면 지난 주차 식단표를 잡을 수 있어 여기서 끊는다
      if (post.create_at < cutoff) return null
      const file = await pick10FFile(token, post)
      if (file) {
        console.log(`식단 이미지 발견: ${file.fileName} (${file.fileId})`)
        return file
      }
    }

    if (order.length < POSTS_PER_PAGE) return null
  }

  console.warn(`채널 ${channelId}: 최근 ${MAX_POST_PAGES}페이지에서 식단표를 찾지 못했습니다.`)
  return null
}

// 가입한 모든 팀/채널에서 식단표 포스트를 검색 (지정 채널에서 못 찾았을 때의 최후 폴백)
async function searchLatest10FImage(token) {
  const teams = await (await mmApi(token, '/users/me/teams')).json()
  const candidates = []

  for (const team of teams) {
    let data
    try {
      const res = await fetch(`${MM_SERVER}/api/v4/teams/${team.id}/posts/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms: '식단표 공존식단', is_or_search: true }),
      })
      if (!res.ok) continue
      data = await res.json()
    } catch {
      continue
    }
    for (const postId of data.order ?? []) {
      const post = data.posts?.[postId]
      if (post?.file_ids?.length) candidates.push(post)
    }
  }

  candidates.sort((a, b) => b.create_at - a.create_at)
  console.log(`검색된 식단표 후보 포스트: ${candidates.length}개`)

  for (const post of candidates) {
    const file = await pick10FFile(token, post)
    if (file) {
      console.log(`식단 이미지 발견(검색): ${file.fileName}, 채널 ${post.channel_id}`)
      console.log(
        `→ 지정 채널(${MENU_CHANNEL_URL})이 아닌 곳에서 찾았습니다. ` +
        `이 채널로 고정하려면 MM_MENU_CHANNEL_ID=${post.channel_id} 시크릿을 설정하세요.`
      )
      return file
    }
  }
  return null
}

async function downloadImage(token, fileId) {
  const res = await mmApi(token, `/files/${fileId}`)
  return Buffer.from(await res.arrayBuffer())
}

// ── 중복 파싱 방지 ──────────────────────────────────────────────────────────

function readLastParsed() {
  try {
    return JSON.parse(fs.readFileSync(LAST_PARSED_FILE, 'utf-8'))
  } catch {
    return null
  }
}

function writeLastParsed(record) {
  fs.writeFileSync(LAST_PARSED_FILE, JSON.stringify(record, null, 2), 'utf-8')
}

// ── Gemini 파싱 ────────────────────────────────────────────────────────────

// 과부하(503)·레이트리밋(429) 같은 일시적 실패는 재시도, 인증/요청 오류는 즉시 중단
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const FATAL_STATUS = new Set([400, 401, 403])
// 한 모델이 계속 과부하면 다음 모델로 폴백 (쉼표 구분으로 재정의 가능)
const GEMINI_MODELS = (process.env.GEMINI_MODELS ?? 'gemini-2.5-flash,gemini-2.5-pro')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean)
const MAX_ATTEMPTS = 4

const sleep = ms => new Promise(r => setTimeout(r, ms))

// SDK가 status를 채우지 않는 경우도 있어 메시지의 "[503 ...]" 패턴까지 확인
function errStatus(e) {
  if (Number.isInteger(e?.status)) return e.status
  const m = String(e?.message ?? '').match(/\[(\d{3})\s/)
  return m ? Number(m[1]) : null
}

// 응답이 JSON이 아니거나 검증에 걸린 경우도 비결정적이라 재시도할 가치가 있음
function retryableError(message) {
  const e = new Error(message)
  e.retryable = true
  return e
}

const PROMPT = `이 이미지는 멀티캠퍼스 10층 식당의 주간 식단표입니다.

각 요일(월~금)의 식단을 아래 JSON 형식으로 정리해주세요.
날짜는 이미지에 표시된 숫자 그대로 사용하세요 (예: "5.12").
연도는 4자리 숫자로 적어주세요 (예: 2026).

{
  "year": 2026,
  "month": 5,
  "days": [
    {
      "dayOfWeek": "월요일",
      "date": "5.12",
      "meals": {
        "도시락": ["메뉴1", "메뉴2"],
        "브런치": ["메뉴1", "메뉴2"],
        "샐러드": ["메뉴1", "메뉴2"]
      }
    }
  ]
}

메뉴 이름은 이미지에 표시된 그대로 정확하게 적어주세요.
JSON만 출력하고 다른 설명은 하지 마세요.`

async function callGemini(modelName, imageBuffer) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({ model: modelName })

  const result = await model.generateContent([
    PROMPT,
    { inlineData: { data: imageBuffer.toString('base64'), mimeType: 'image/png' } },
  ])

  const text = result.response.text()
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw retryableError('Gemini 응답에서 JSON 추출 실패')

  let parsed
  try {
    parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
  } catch (e) {
    throw retryableError(`Gemini 응답 JSON 파싱 실패: ${e.message}`)
  }

  if (!Number.isInteger(parsed.year) || parsed.year < 2020 || parsed.year > 2100) {
    throw retryableError(`비정상 연도 파싱됨: ${parsed.year}`)
  }
  if (!parsed.days?.length) throw retryableError('파싱된 식단이 없습니다')

  return parsed
}

async function parseWithGemini(imageBuffer) {
  const failures = []

  for (const modelName of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const parsed = await callGemini(modelName, imageBuffer)
        console.log(`✓ ${modelName} 파싱 성공 (${attempt}회차)`)
        return parsed
      } catch (e) {
        const status = errStatus(e)
        const label = `${modelName} ${attempt}/${MAX_ATTEMPTS}`
        failures.push(`${label}: ${e.message}`)

        // 잘못된 키·권한 문제는 재시도도 폴백도 무의미
        if (status !== null && FATAL_STATUS.has(status)) {
          console.error(`${label} 실패(재시도 불가): ${e.message}`)
          throw e
        }
        // 재시도 대상이 아니면(예: 없는 모델 404) 바로 다음 모델로
        const canRetry = e.retryable === true || (status !== null && RETRYABLE_STATUS.has(status))
        if (!canRetry || attempt === MAX_ATTEMPTS) {
          console.warn(`${label} 실패: ${e.message} → 다음 모델로 폴백`)
          break
        }
        const wait = 5000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 1000)
        console.warn(`${label} 실패: ${e.message} → ${wait}ms 후 재시도`)
        await sleep(wait)
      }
    }
  }

  throw new Error(
    `Gemini 파싱 실패 (모델 ${GEMINI_MODELS.length}개, 모델당 최대 ${MAX_ATTEMPTS}회 시도)\n` +
    failures.map(f => `  - ${f}`).join('\n')
  )
}

// ── JSON 저장 ──────────────────────────────────────────────────────────────

function saveDailyJsons(parsed) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

  const saved = []
  for (const day of parsed.days) {
    const parts = String(day.date).split('.').map(Number)
    const month = parts.length > 1 ? parts[0] : parsed.month
    const dayOfMonth = parts.length > 1 ? parts[1] : parts[0]
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      console.warn(`날짜 해석 불가, 건너뜀: ${day.dayOfWeek} "${day.date}"`)
      continue
    }
    const dateStr = `${parsed.year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`

    const meals = Object.entries(day.meals ?? {})
      .map(([courseName, items]) => ({
        courseName,
        items: (items ?? []).map(i => i.replace(/^[&＆]\s*/, '').trim()).filter(Boolean),
      }))
      .filter(m => m.items.length > 0)
      .map(m => ({
        name: m.items.join(', '),
        courseName: m.courseName,
        setName: '10층 공존식단',
        items: m.items,
      }))

    const output = {
      date: dateStr,
      dayOfWeek: day.dayOfWeek,
      restaurant: '멀티캠퍼스 10층',
      mealTime: '점심',
      meals,
      updatedAt: new Date().toISOString(),
    }

    fs.writeFileSync(path.join(DATA_DIR, `${dateStr}.json`), JSON.stringify(output, null, 2), 'utf-8')
    console.log(`✓ 저장: data-10f/${dateStr}.json`)
    saved.push(dateStr)
  }

  if (!saved.length) throw new Error('저장된 날짜가 하나도 없습니다')
  return saved
}

// ── 메인 ──────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.MM_LOGIN_JSON) throw new Error('MM_LOGIN_JSON 환경변수가 필요합니다')
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 환경변수가 필요합니다')

  console.log('Mattermost 로그인 중...')
  const token = await mmLogin()

  // 채널 URL로 지정한 곳 → MM_MENU_CHANNEL_ID 오버라이드 → 옛 스레드 순으로 시도
  const channelIds = []
  const addChannel = id => {
    if (id && !channelIds.includes(id)) channelIds.push(id)
  }
  addChannel(await resolveChannelIdByName(token))
  addChannel(process.env.MM_MENU_CHANNEL_ID)

  let image = null
  for (const channelId of channelIds) {
    console.log(`식단표 채널 탐색: ${channelId}`)
    image = await findLatest10FImage(token, channelId)
    if (image) break
  }

  if (!image) {
    const threadChannelId = await resolveChannelIdByThread(token)
    if (threadChannelId && !channelIds.includes(threadChannelId)) {
      console.log(`옛 식단표 스레드 채널 탐색: ${threadChannelId}`)
      image = await findLatest10FImage(token, threadChannelId)
    }
  }
  if (!image) {
    console.log('가입 채널 전체에서 식단표 검색 중...')
    image = await searchLatest10FImage(token)
  }
  if (!image) {
    throw new Error(
      `10층 식단표를 찾지 못했습니다. 이 MM 계정이 ${MENU_CHANNEL_URL} 채널에 ` +
      '가입되어 있는지 확인하거나, MM_MENU_CHANNEL_ID 시크릿으로 채널을 지정하세요.'
    )
  }

  const last = readLastParsed()
  if (last?.fileId === image.fileId) {
    console.log(`이미 파싱한 식단표입니다 (${image.fileName}).`)
    return
  }

  console.log('이미지 다운로드 중...')
  const imageBuffer = await downloadImage(token, image.fileId)

  console.log('Gemini로 파싱 중...')
  const parsed = await parseWithGemini(imageBuffer)
  const saved = saveDailyJsons(parsed)

  writeLastParsed({
    fileId: image.fileId,
    fileName: image.fileName,
    parsedAt: new Date().toISOString(),
    dates: saved,
  })

  console.log(`✓ 완료! ${saved.length}일치 식단 저장`)
}

// 실행 후 오늘자(KST) 식단이 없으면 경고 웹훅 발송
async function checkTodayCovered() {
  const today = getKSTDateStr()
  if (fs.existsSync(path.join(DATA_DIR, `${today}.json`))) return
  console.warn(`오늘(${today}) 식단 데이터 없음 → 경고 발송`)
  await sendAlert(
    `오늘(${today})의 10층 식단 데이터가 없습니다.\n` +
    `이번 주 식단표가 아직 채널에 올라오지 않았거나, 수집에 실패했을 수 있어요.\n` +
    `채널을 확인해 주세요: ${MENU_CHANNEL_URL}`
  )
}

main()
  .then(checkTodayCovered)
  .catch(async e => {
    console.error(e.message ?? e)
    await sendAlert(`수집 실행 자체가 실패했습니다:\n\`\`\`\n${e.message ?? e}\n\`\`\``)
    process.exit(1)
  })
