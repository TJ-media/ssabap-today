'use strict'

const { WelstoryClient } = require('welstory-api-wrapper')
const fs = require('fs')
const path = require('path')

// ── 날짜 유틸 ──────────────────────────────────────────────────────────────

function getKSTDateStr() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}

function formatDateKo(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${y}년 ${String(m).padStart(2, '0')}월 ${String(d).padStart(2, '0')}일 (${days[dow]})`
}

// ── 20층 Welstory ──────────────────────────────────────────────────────────

async function fetch20F(dateStr) {
  const client = new WelstoryClient()
  await client.login({
    username: process.env.WELSTORY_USERNAME,
    password: process.env.WELSTORY_PASSWORD,
  })

  const restaurants = await client.searchRestaurant('멀티캠퍼스')
  if (!restaurants.length) throw new Error('멀티캠퍼스 식당을 찾을 수 없습니다')

  const restaurant = restaurants[0]
  if (!(await restaurant.checkIsRegistered())) await restaurant.register()

  const mealTimes = await restaurant.listMealTimes()
  const lunch = mealTimes.find(m => m.name.includes('중식')) ?? mealTimes[1]

  const dateNum = parseInt(dateStr.replace(/-/g, ''), 10)
  return restaurant.listMeal(dateNum, lunch.id)
}

function format20FText(meals) {
  if (!meals.length) return '_오늘 메뉴 정보 없음_'

  const courseEmoji = { '한식': '🍚', '양식': '🍝', '일식': '🍱', '중식': '🥢', '분식': '🥘' }

  return meals.map(meal => {
    const course = meal.menuCourseName ?? ''
    const emoji = Object.entries(courseEmoji).find(([k]) => course.includes(k))?.[1] ?? '🍴'
    const setDesc = meal.setName ? meal.setName.replace(/&/g, ' · ') : meal.name
    return `${emoji} **[${course}]** ${setDesc}`
  }).join('\n')
}

// ── 10층 공존식단 ──────────────────────────────────────────────────────────

function read10F(dateStr) {
  const fp = path.join(__dirname, '..', 'data-10f', `${dateStr}.json`)
  if (!fs.existsSync(fp)) return null
  return JSON.parse(fs.readFileSync(fp, 'utf-8'))
}

function format10FText(data) {
  if (!data?.meals?.length) return '_주간 식단표 미게시 또는 데이터 준비 중_'

  const emoji = { '도시락': '🍱', '브런치': '☕', '샐러드': '🥗' }
  return data.meals.map(meal => {
    const e = emoji[meal.courseName] ?? '🍴'
    const items = meal.items?.join(' · ') ?? meal.name
    return `${e} **${meal.courseName}**: ${items}`
  }).join('\n')
}

// ── Mattermost 웹훅 ────────────────────────────────────────────────────────

async function sendWebhook(payload) {
  const res = await fetch(process.env.MM_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`웹훅 발송 실패: HTTP ${res.status}`)
}

// ── 메인 ──────────────────────────────────────────────────────────────────

async function main() {
  const dateStr = getKSTDateStr()
  const dateKo = formatDateKo(dateStr)
  console.log(`[${dateStr}] 식단 알림 발송 시작`)

  // 20층 fetch
  let meals20f = []
  let err20f = null
  try {
    meals20f = await fetch20F(dateStr)
    console.log(`20층: ${meals20f.length}개 코스 조회 완료`)
  } catch (e) {
    err20f = e.message
    console.error('20층 조회 실패:', e.message)
  }

  // 10층 read
  const data10f = read10F(dateStr)
  console.log(`10층: ${data10f ? '데이터 있음' : '데이터 없음'}`)

  // 20층 대표 사진 (첫 번째 코스 photoUrl 사용)
  const photoUrl = meals20f.find(m => m.photoUrl)?.photoUrl ?? null

  const payload = {
    text: `### 🍽️ 오늘의 SSAFY 점심 식단\n📅 **${dateKo}**`,
    attachments: [
      {
        color: '#0060a9',
        title: '🏢 20층 삼성웰스토리',
        text: err20f ? `_조회 실패: ${err20f}_` : format20FText(meals20f),
        ...(photoUrl ? { image_url: photoUrl } : {}),
        footer: 'Samsung Welstory',
      },
      {
        color: '#d87b00',
        title: '🏢 10층 공존식단',
        text: format10FText(data10f),
      },
    ],
  }

  await sendWebhook(payload)
  console.log('✓ 알림 발송 완료')
}

main().catch(e => { console.error(e); process.exit(1) })
