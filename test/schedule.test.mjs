// test/schedule.test.mjs
// 覆盖：北京时间换算、签到小时判定、待签账号计算、当日进度合并、完成判定。
// 这些是「每 15 分钟轮询 + 按小时归属」调度的地基，出错会直接导致漏签或重复签到。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beijingParts,
  CRON_INTERVAL_MINUTES,
  DEFAULT_CHECKIN_HOUR,
  deriveCronTexts,
  isCheckinHour,
  isDayComplete,
  isDoneResult,
  mergeDayRecord,
  pendingAccountIds,
} from '../src/schedule.js';

/** UTC 时刻 -> 毫秒。 */
function utc(y, mo, d, h, mi = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}

// ============ 时区换算 ============

test('beijingParts：UTC 00:00 是北京时间同日 08:00', () => {
  const { date, hour } = beijingParts(utc(2026, 11, 14, 0, 0));
  assert.equal(date, '2026-11-14');
  assert.equal(hour, 8);
});

test('beijingParts：UTC 16:00 已经跨到北京时间的第二天 00:00', () => {
  const { date, hour } = beijingParts(utc(2026, 11, 13, 16, 0));
  assert.equal(date, '2026-11-14');
  assert.equal(hour, 0);
});

test('beijingParts：UTC 23:45 对应北京时间次日 07:45', () => {
  const { date, hour } = beijingParts(utc(2026, 11, 13, 23, 45));
  assert.equal(date, '2026-11-14');
  assert.equal(hour, 7);
});

test('beijingParts：非法时间戳不抛错（回落 1970）', () => {
  const { date, hour } = beijingParts(NaN);
  assert.equal(typeof date, 'string');
  assert.equal(Number.isInteger(hour), true);
});

// ============ 签到小时判定 ============

test('isCheckinHour：只在配置的北京小时成立，前后一小时都 false', () => {
  const settings = { checkinHour: 8 };
  assert.equal(isCheckinHour(settings, utc(2026, 11, 14, 0, 0)), true);
  assert.equal(isCheckinHour(settings, utc(2026, 11, 14, 1, 0)), false); // 北京 09:00
  assert.equal(isCheckinHour(settings, utc(2026, 11, 13, 23, 0)), false); // 北京 07:00
});

test('isCheckinHour：同一小时内 4 次轮询都算命中', () => {
  const settings = { checkinHour: 8 };
  for (const minute of [0, 15, 30, 45]) {
    assert.equal(isCheckinHour(settings, utc(2026, 11, 14, 0, minute)), true, `:${minute} 应命中`);
  }
});

test('isCheckinHour：checkinHour 缺失/非法时回落到默认 8 点', () => {
  assert.equal(isCheckinHour({}, utc(2026, 11, 14, 0, 0)), true);
  assert.equal(isCheckinHour({ checkinHour: 'abc' }, utc(2026, 11, 14, 0, 0)), true);
  assert.equal(DEFAULT_CHECKIN_HOUR, 8);
});

test('isCheckinHour：支持字符串数字（KV 里被写成字符串也不炸）', () => {
  assert.equal(isCheckinHour({ checkinHour: 8 }, utc(2026, 11, 14, 0, 0)), true);
});

test('deriveCronTexts：北京 08:00 对应 UTC 00:00', () => {
  assert.deepEqual(deriveCronTexts(8), { cronUtc: '00:00', cronLocal: '08:00' });
});

test('deriveCronTexts：北京 00:00 对应 UTC 16:00（前一日）', () => {
  assert.deepEqual(deriveCronTexts(0), { cronUtc: '16:00', cronLocal: '00:00' });
});

test('deriveCronTexts：越界小时按 24 取模，非法值回落默认', () => {
  assert.equal(deriveCronTexts(25).cronLocal, '01:00');
  assert.equal(deriveCronTexts(-1).cronLocal, '23:00');
  assert.equal(deriveCronTexts(NaN).cronLocal, '08:00');
});

test('CRON_INTERVAL_MINUTES 与部署表达式一致', () => {
  assert.equal(CRON_INTERVAL_MINUTES, 15);
});

// ============ 待签账号 ============

const ACC1 = { id: 'acc_1', enabled: true };
const ACC2 = { id: 'acc_2', enabled: true };
const DATE = '2026-11-14';

test('pendingAccountIds：没有当日记录时全部待签', () => {
  assert.deepEqual(pendingAccountIds([ACC1, ACC2], null, DATE), ['acc_1', 'acc_2']);
});

test('pendingAccountIds：记录是昨天的等于没记录', () => {
  const day = { date: '2026-11-13', accounts: { acc_1: { result: 'checked_in' } } };
  assert.deepEqual(pendingAccountIds([ACC1, ACC2], day, DATE), ['acc_1', 'acc_2']);
});

test('pendingAccountIds：已成功的账号被排除，失败的不写记录所以仍待签', () => {
  const day = {
    date: DATE,
    accounts: { acc_1: { result: 'checked_in' }, acc_2: { result: 'failed' } },
  };
  assert.deepEqual(pendingAccountIds([ACC1, ACC2], day, DATE), ['acc_2']);
});

test('pendingAccountIds：already_checked_in 也算完成（幂等语义）', () => {
  const day = { date: DATE, accounts: { acc_1: { result: 'already_checked_in' } } };
  assert.deepEqual(pendingAccountIds([ACC1, ACC2], day, DATE), ['acc_2']);
});

test('pendingAccountIds：脏账号（无 id）被过滤掉', () => {
  assert.deepEqual(pendingAccountIds([ACC1, { enabled: true }, null], null, DATE), ['acc_1']);
});

// ============ 合并当日进度 ============

test('mergeDayRecord：只写入成功结果，失败不入库', () => {
  const merged = mergeDayRecord(null, DATE, [
    { accountId: 'acc_1', result: 'checked_in' },
    { accountId: 'acc_2', result: 'failed' },
  ], '2026-11-14T00:01:00.000Z');

  assert.ok(merged);
  assert.equal(merged.date, DATE);
  assert.deepEqual(Object.keys(merged.accounts), ['acc_1']);
  assert.equal(merged.accounts.acc_1.result, 'checked_in');
  assert.equal(merged.accounts.acc_1.at, '2026-11-14T00:01:00.000Z');
});

test('mergeDayRecord：跨天的旧记录不继承', () => {
  const old = { date: '2026-11-13', accounts: { acc_1: { result: 'checked_in' } } };
  const merged = mergeDayRecord(old, DATE, [{ accountId: 'acc_2', result: 'checked_in' }], 'T');
  assert.deepEqual(Object.keys(merged.accounts), ['acc_2']);
});

test('mergeDayRecord：同一天已有记录时做增量合并', () => {
  const old = { date: DATE, accounts: { acc_1: { result: 'checked_in', at: 'A' } } };
  const merged = mergeDayRecord(old, DATE, [{ accountId: 'acc_2', result: 'checked_in' }], 'B');
  assert.deepEqual(Object.keys(merged.accounts).sort(), ['acc_1', 'acc_2']);
  assert.equal(merged.accounts.acc_1.at, 'A', '已有条目不被覆盖');
});

test('mergeDayRecord：没有任何成功时返回 null，调用方据此跳过写入', () => {
  assert.equal(mergeDayRecord(null, DATE, [{ accountId: 'acc_1', result: 'failed' }], 'T'), null);
  const old = { date: DATE, accounts: { acc_1: { result: 'checked_in', at: 'A' } } };
  assert.equal(mergeDayRecord(old, DATE, [], 'T'), null, '无变化不应触发写');
});

test('mergeDayRecord：结果与上次完全相同时不重复写', () => {
  const old = { date: DATE, accounts: { acc_1: { result: 'checked_in', at: 'A' } } };
  assert.equal(mergeDayRecord(old, DATE, [{ accountId: 'acc_1', result: 'checked_in' }], 'B'), null);
});

// ============ 完成判定 ============

test('isDayComplete：全部成功才 true', () => {
  const day = { date: DATE, accounts: { acc_1: { result: 'checked_in' }, acc_2: { result: 'already_checked_in' } } };
  assert.equal(isDayComplete([ACC1, ACC2], day, DATE), true);
  assert.equal(isDayComplete([ACC1, ACC2, { id: 'acc_3' }], day, DATE), false);
  assert.equal(isDayComplete([], null, DATE), true, '没有启用账号视为无事可做');
});

test('isDoneResult：只有两类结果算完成', () => {
  assert.equal(isDoneResult('checked_in'), true);
  assert.equal(isDoneResult('already_checked_in'), true);
  assert.equal(isDoneResult('failed'), false);
  assert.equal(isDoneResult('skipped_disabled'), false);
});
