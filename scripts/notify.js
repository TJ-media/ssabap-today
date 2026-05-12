'use strict'

const BASE = 'https://raw.githubusercontent.com/C4T4767/baptimessafy/main'

// ── 날짜 ──────────────────────────────────────────────────────────────────

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

// ── 데이터 fetch ───────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) return null
  return res.json()
}

// ── 메시지 포맷 ────────────────────────────────────────────────────────────

function build20FAttachments(data) {
  if (!data?.meals?.length) {
    return [{ color: '#0060a9', title: '🏢 20층 삼성웰스토리', text: '_오늘 메뉴 정보 없음_' }]
  }

  const courseEmoji = { '한식': '🍚', '양식': '🍝', '일식': '🍱', '중식': '🥢', '분식': '🥘' }

  return data.meals.map(meal => {
    const course = meal.courseName ?? ''
    const emoji = Object.entries(courseEmoji).find(([k]) => course.includes(k))?.[1] ?? '🍴'

    // 메인 메뉴 + 전체 반찬 목록
    const mainItem = meal.nutrition?.find(n => n.isMain)
    const sides = meal.nutrition?.filter(n => !n.isMain) ?? []

    let text = ''
    if (mainItem) {
      text += `**${mainItem.name}**`
      if (sides.length) text += `\n${sides.map(n => n.name).join(' · ')}`
    } else {
      // nutrition 없으면 setName 폴백
      text = meal.setName ? meal.setName.replace(/&/g, ' · ') : meal.name
    }

    return {
      color: '#0060a9',
      title: `${emoji} 20층 삼성웰스토리 | ${course}`,
      text,
      ...(meal.photoUrl ? { image_url: meal.photoUrl } : {}),
      footer: 'Samsung Welstory',
    }
  })
}

function format10F(data) {
  if (!data?.meals?.length) return '_오늘 메뉴 정보 없음_'

  const emoji = { '도시락': '🍱', '브런치': '🥪', '샐러드': '🥗' }
  const label = { '브런치': '샌드위치' }

  return data.meals.map(meal => {
    const e = emoji[meal.courseName] ?? '🍴'
    const name = label[meal.courseName] ?? meal.courseName
    const items = meal.items?.join(' · ') ?? meal.name
    return `${e} **${name}**: ${items}`
  }).join('\n')
}

// ── 웹훅 발송 ──────────────────────────────────────────────────────────────

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
  console.log(`[${dateStr}] 식단 알림 발송 시작`)

  const [data20f, data10f] = await Promise.all([
    fetchJson(`${BASE}/data/${dateStr}.json`),
    fetchJson(`${BASE}/data-10f/${dateStr}.json`),
  ])

  console.log(`20층: ${data20f ? '데이터 있음' : '없음'}, 10층: ${data10f ? '데이터 있음' : '없음'}`)

  const payload = {
    text: `### 🍽️ 오늘의 싸밥\n📅 **${formatDateKo(dateStr)}**`,
    attachments: [
      ...build20FAttachments(data20f),
      {
        color: '#d87b00',
        title: '🏢 10층 공존식단',
        text: format10F(data10f),
      },
    ],
  }

  await sendWebhook(payload)
  console.log('✓ 알림 발송 완료')
}

main().catch(e => { console.error(e); process.exit(1) })
