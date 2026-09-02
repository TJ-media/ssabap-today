'use strict'

const RealDate = Date
const dateStr = process.env.NOTIFY_TEST_DATE
const fixedTime = RealDate.parse(`${dateStr}T00:00:00+09:00`)

class FakeDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [fixedTime]))
  }

  static now() {
    return fixedTime
  }
}

global.Date = FakeDate

const menuMode = process.env.NOTIFY_TEST_MENU_MODE
const holidayStatus = process.env.NOTIFY_TEST_HOLIDAY_STATUS
const data20f = {
  meals: [{
    courseName: '한식',
    nutrition: [{ name: '테스트 메뉴', isMain: true }],
  }],
}
const data10f = {
  meals: [{ courseName: '도시락', items: ['테스트 메뉴'] }],
}

global.fetch = async url => {
  const target = String(url)

  if (target.startsWith('https://holidays.hyunbin.page/')) {
    if (holidayStatus === 'error') return { ok: false, status: 503 }
    return {
      ok: true,
      json: async () => ({ '2026-05-05': ['어린이날'] }),
    }
  }

  if (target.includes('/data-10f/')) {
    const hasMenu = menuMode === 'both' || menuMode === '10f'
    return { ok: hasMenu, json: async () => data10f }
  }

  if (target.includes('/data/')) {
    const hasMenu = menuMode === 'both' || menuMode === '20f'
    return { ok: hasMenu, json: async () => data20f }
  }

  if (target === process.env.MM_WEBHOOK_URL) {
    return { ok: true }
  }

  throw new Error(`예상하지 못한 fetch: ${target}`)
}
