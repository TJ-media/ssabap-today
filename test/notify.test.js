'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const root = path.join(__dirname, '..')
const preload = path.join(__dirname, 'fixtures', 'notify-preload.js')
const notifyScript = path.join(root, 'scripts', 'notify.js')

function runNotify(date, menuMode, holidayStatus = 'ok') {
  return spawnSync(process.execPath, ['--require', preload, notifyScript], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      MM_WEBHOOK_URL: 'https://example.test/hook',
      NOTIFY_TEST_DATE: date,
      NOTIFY_TEST_MENU_MODE: menuMode,
      NOTIFY_TEST_HOLIDAY_STATUS: holidayStatus,
    },
  })
}

test('공휴일에는 양쪽 메뉴 데이터가 있어도 알림을 보내지 않는다', () => {
  const result = runNotify('2026-05-05', 'both')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /공휴일.*알림 건너뜀/)
  assert.doesNotMatch(result.stdout, /✓ 발송:/)
})

test('양쪽 메뉴가 모두 없으면 평일에도 알림을 보내지 않는다', () => {
  const result = runNotify('2026-09-07', 'none')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /두 층 모두 메뉴 없음.*알림 건너뜀/)
  assert.doesNotMatch(result.stdout, /✓ 발송:/)
})

test('공휴일이 아닌 날에 메뉴가 있으면 알림을 보낸다', () => {
  const result = runNotify('2026-09-07', '20f')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /✓ 알림 발송 완료/)
  assert.match(result.stdout, /✓ 발송:/)
})

test('공휴일 정보를 확인하지 못하면 알림을 보내지 않고 실패한다', () => {
  const result = runNotify('2026-09-07', 'both', 'error')

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /공휴일 정보 조회 실패/)
  assert.doesNotMatch(result.stdout, /✓ 발송:/)
})
