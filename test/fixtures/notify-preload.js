'use strict'

const fs = require('node:fs')
const path = require('node:path')

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

const realReadFileSync = fs.readFileSync
fs.readFileSync = function (file, ...args) {
  if (String(file).includes(`${path.sep}data-10f${path.sep}`)) {
    const error = new Error(`테스트에서 로컬 식단 파일을 차단함: ${file}`)
    error.code = 'ENOENT'
    throw error
  }
  return realReadFileSync.call(this, file, ...args)
}

const menuMode = process.env.NOTIFY_TEST_MENU_MODE
const holidayStatus = process.env.NOTIFY_TEST_HOLIDAY_STATUS
const realAbortTimeout = AbortSignal.timeout.bind(AbortSignal)
if (holidayStatus === 'hang') {
  AbortSignal.timeout = () => realAbortTimeout(20)
}
const data20f = {
  meals: [{
    courseName: '한식',
    nutrition: [{ name: '테스트 메뉴', isMain: true }],
  }],
}
const data10f = {
  meals: [{ courseName: '도시락', items: ['테스트 메뉴'] }],
}

global.fetch = async (url, options = {}) => {
  const target = String(url)

  if (target.startsWith('https://holidays.hyunbin.page/')) {
    if (holidayStatus === 'hang') {
      return new Promise((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1000)
        const abort = () => {
          clearInterval(keepAlive)
          reject(options.signal?.reason ?? new Error('aborted'))
        }
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (holidayStatus === 'error') return { ok: false, status: 503 }
    if (holidayStatus === 'empty') return { ok: true, json: async () => ({}) }
    if (holidayStatus === 'malformed') {
      return { ok: true, json: async () => ({ '2026-05-05': [] }) }
    }
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
    console.log(`TEST_WEBHOOK_CALL ${options.method}`)
    return { ok: true }
  }

  throw new Error(`예상하지 못한 fetch: ${target}`)
}
