'use strict'

const { GoogleGenerativeAI } = require('@google/generative-ai')
const fs = require('fs')
const path = require('path')

const MM_SERVER = 'https://meeting.ssafy.com'
// 10층 식단표가 매주 올라오는 스레드의 루트 포스트 (채널 ID 추적용)
const MENU_THREAD_POST_ID = '1k43iwapofrtbe3a7d66ed9izo'

const DATA_DIR = path.join(__dirname, '..', 'data-10f')
const LAST_PARSED_FILE = path.join(DATA_DIR, '.last-parsed.json')

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

async function resolveMenuChannelId(token) {
  // 시크릿으로 채널을 직접 지정하면 스레드 조회 없이 사용
  if (process.env.MM_MENU_CHANNEL_ID) return process.env.MM_MENU_CHANNEL_ID

  try {
    const res = await mmApi(token, `/posts/${MENU_THREAD_POST_ID}`)
    const post = await res.json()
    return post.channel_id
  } catch (e) {
    if (e.status === 403) {
      throw new Error(
        '식단표 스레드 접근 403: 이 계정이 해당 채널에 가입되어 있지 않습니다. ' +
        'Mattermost에서 식단표가 올라오는 채널에 먼저 가입하거나, ' +
        'MM_MENU_CHANNEL_ID 시크릿으로 채널 ID를 직접 지정하세요.'
      )
    }
    throw e
  }
}

// 채널 최신 포스트부터 탐색 (스레드 API의 perPage=60 앞쪽 고정 문제 회피)
async function findLatest10FImage(token, channelId) {
  const res = await mmApi(token, `/channels/${channelId}/posts?per_page=100`)
  const data = await res.json()

  // order는 최신순 정렬
  for (const postId of data.order) {
    const post = data.posts[postId]
    if (!post.message?.includes('식단표 공유')) continue
    if (!post.file_ids?.length) continue

    for (const fileId of post.file_ids) {
      let info
      try {
        info = await (await mmApi(token, `/files/${fileId}/info`)).json()
      } catch {
        continue
      }
      const isPng =
        info.mime_type === 'image/png' || info.name?.toLowerCase().endsWith('.png')
      if (isPng && info.name?.includes('10층')) {
        console.log(`식단 이미지 발견: ${info.name} (${fileId})`)
        return { fileId, fileName: info.name }
      }
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

async function parseWithGemini(imageBuffer) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const prompt = `이 이미지는 멀티캠퍼스 10층 식당의 주간 식단표입니다.

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

  const result = await model.generateContent([
    prompt,
    { inlineData: { data: imageBuffer.toString('base64'), mimeType: 'image/png' } },
  ])

  const text = result.response.text()
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Gemini 응답에서 JSON 추출 실패')

  const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])

  if (!Number.isInteger(parsed.year) || parsed.year < 2020 || parsed.year > 2100) {
    throw new Error(`비정상 연도 파싱됨: ${parsed.year}`)
  }
  if (!parsed.days?.length) throw new Error('파싱된 식단이 없습니다')

  return parsed
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

  const channelId = await resolveMenuChannelId(token)
  console.log(`식단표 채널: ${channelId}`)

  const image = await findLatest10FImage(token, channelId)
  if (!image) {
    console.log('채널 최근 포스트에서 10층 식단표를 찾지 못했습니다. 종료.')
    return
  }

  const last = readLastParsed()
  if (last?.fileId === image.fileId) {
    console.log(`이미 파싱한 식단표입니다 (${image.fileName}). 종료.`)
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

main().catch(e => { console.error(e.message ?? e); process.exit(1) })
