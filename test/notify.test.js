'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const root = path.join(__dirname, '..')
const preload = path.join(__dirname, 'fixtures', 'notify-preload.js')
const notifyScript = path.join(root, 'scripts', 'notify.js')

function runNotify(date, menuMode, holidayStatus = 'ok', timeout = 5000) {
  return spawnSync(process.execPath, ['--require', preload, notifyScript], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      MM_WEBHOOK_URL: 'https://example.test/hook',
      NOTIFY_TEST_DATE: date,
      NOTIFY_TEST_MENU_MODE: menuMode,
      NOTIFY_TEST_HOLIDAY_STATUS: holidayStatus,
    },
  })
}

function assertWebhookCalls(result, expected) {
  const calls = result.stdout.match(/^TEST_WEBHOOK_CALL /gm) ?? []
  assert.equal(calls.length, expected)
}

test('공휴일에는 양쪽 메뉴 데이터가 있어도 알림을 보내지 않는다', () => {
  const result = runNotify('2026-05-05', 'both')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /공휴일.*알림 건너뜀/)
  assertWebhookCalls(result, 0)
})

test('양쪽 메뉴가 모두 없으면 평일에도 알림을 보내지 않는다', () => {
  const result = runNotify('2026-09-02', 'none')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /두 층 모두 메뉴 없음.*알림 건너뜀/)
  assertWebhookCalls(result, 0)
})

for (const menuMode of ['20f', '10f']) {
  test(`공휴일이 아닌 날에 ${menuMode} 메뉴가 있으면 알림을 보낸다`, () => {
    const result = runNotify('2026-09-07', menuMode)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /✓ 알림 발송 완료/)
    assert.match(result.stdout, /TEST_WEBHOOK_CALL POST/)
    assertWebhookCalls(result, 1)
  })
}

test('공휴일 정보를 확인하지 못하면 알림을 보내지 않고 실패한다', () => {
  const result = runNotify('2026-09-07', 'both', 'error')

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /공휴일 정보 조회 실패/)
  assertWebhookCalls(result, 0)
})

test('공휴일 정보가 빈 객체면 알림을 보내지 않고 실패한다', () => {
  const result = runNotify('2026-09-07', 'both', 'empty')

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /공휴일 정보 조회 실패.*응답 형식 오류/)
  assertWebhookCalls(result, 0)
})

test('공휴일명이 빈 배열이면 알림을 보내지 않고 실패한다', () => {
  const result = runNotify('2026-05-05', 'both', 'malformed')

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /공휴일 정보 조회 실패.*응답 형식 오류/)
  assertWebhookCalls(result, 0)
})

test('공휴일 정보 조회가 멈추면 시간 초과로 실패하고 알림을 보내지 않는다', () => {
  const result = runNotify('2026-09-07', 'both', 'hang', 1000)

  assert.equal(result.error, undefined, result.error?.message)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /공휴일 정보 조회 실패.*시간 초과/)
  assertWebhookCalls(result, 0)
})
