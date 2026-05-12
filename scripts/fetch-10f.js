'use strict'

const { GoogleGenerativeAI } = require('@google/generative-ai')
const fs = require('fs')
const path = require('path')

const MM_SERVER = 'https://meeting.ssafy.com'

// ── Mattermost API ─────────────────────────────────────────────────────────

async function mmLogin() {
  const { login_id, password } = JSON.parse(process.env.MM_LOGIN_JSON)
  const res = await fetch(`${MM_SERVER}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id, password }),
  })
  if (!res.ok) throw new Error(`MM 로그인 실패: HTTP ${res.status}`)
  const token = res.headers.get('Token')
  if (!token) throw new Error('응답에 토큰 없음')
  return token
}

async function findLatestMenuImage(token, channelId) {
  const res = await fetch(
    `${MM_SERVER}/api/v4/channels/${channelId}/posts?per_page=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`채널 포스트 조회 실패: HTTP ${res.status}`)
  const data = await res.json()

  for (const postId of data.order) {
    const post = data.posts[postId]
    if (!post.file_ids?.length) continue

    for (const fileId of post.file_ids) {
      const infoRes = await fetch(`${MM_SERVER}/api/v4/files/${fileId}/info`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!infoRes.ok) continue
      const info = await infoRes.json()

      const isPng =
        info.mime_type === 'image/png' ||
        info.name?.toLowerCase().endsWith('.png')

      if (isPng) {
        console.log(`이미지 발견: ${info.name} (${fileId})`)
        return fileId
      }
    }
  }
  throw new Error('채널에서 PNG 이미지를 찾을 수 없습니다')
}

async function downloadImage(token, fileId) {
  const res = await fetch(`${MM_SERVER}/api/v4/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`이미지 다운로드 실패: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// ── Gemini 파싱 ────────────────────────────────────────────────────────────

async function parseWithGemini(imageBuffer) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

  const prompt = `이 이미지는 멀티캠퍼스 10층 식당의 주간 식단표입니다.

각 요일(월~금)의 식단을 아래 JSON 형식으로 정리해주세요.
날짜는 이미지에 표시된 숫자 그대로 사용하세요 (예: "5.12").

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

JSON만 출력하고 다른 설명은 하지 마세요.`

  const result = await model.generateContent([
    prompt,
    { inlineData: { data: imageBuffer.toString('base64'), mimeType: 'image/png' } },
  ])

  const text = result.response.text()
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Gemini 응답에서 JSON 추출 실패')

  return JSON.parse(jsonMatch[1] ?? jsonMatch[0])
}

// ── JSON 저장 ──────────────────────────────────────────────────────────────

function saveDailyJsons(parsed) {
  const dataDir = path.join(__dirname, '..', 'data-10f')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

  for (const day of parsed.days) {
    const parts = day.date.split('.').map(Number)
    const month = parts[0] || parsed.month
    const dayOfMonth = parts[1]
    const dateStr = `${parsed.year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`

    const meals = Object.entries(day.meals)
      .filter(([, items]) => items.length > 0)
      .map(([courseName, items]) => ({
        courseName,
        setName: '10층 공존식단',
        items: items.map(i => i.replace(/^[&＆]\s*/, '').trim()).filter(Boolean),
      }))

    const output = {
      date: dateStr,
      dayOfWeek: day.dayOfWeek,
      restaurant: '멀티캠퍼스 10층',
      mealTime: '점심',
      meals,
      updatedAt: new Date().toISOString(),
    }

    const fp = path.join(dataDir, `${dateStr}.json`)
    fs.writeFileSync(fp, JSON.stringify(output, null, 2), 'utf-8')
    console.log(`✓ 저장: data-10f/${dateStr}.json`)
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────────

async function main() {
  const channelId = process.env.MM_MENU_CHANNEL_ID
  if (!channelId) throw new Error('MM_MENU_CHANNEL_ID 환경변수가 필요합니다')

  console.log('Mattermost 로그인 중...')
  const token = await mmLogin()

  console.log('10층 식단 이미지 검색 중...')
  const fileId = await findLatestMenuImage(token, channelId)

  console.log('이미지 다운로드 중...')
  const imageBuffer = await downloadImage(token, fileId)

  console.log('Gemini로 파싱 중...')
  const parsed = await parseWithGemini(imageBuffer)
  console.log(`파싱 완료: ${parsed.days?.length ?? 0}일치 식단`)

  saveDailyJsons(parsed)
  console.log('✓ 완료!')
}

main().catch(e => { console.error(e); process.exit(1) })
