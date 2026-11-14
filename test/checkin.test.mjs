// test/checkin.test.mjs
// 覆盖：两段式签到（先 status 后 daily）/ 幂等跳过 / 401·403 短路 / 5xx / 超时 / 非 JSON /
//       业务失败 / 请求形状（method、头、body、URL）/ token 不泄漏。
// 对应 AC-7、AC-8、AC-9、AC-19，ARCHITECTURE §8 错误分类表。

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkinAccount, checkinStatus, callUpstream, UPSTREAM_BASE } from '../src/checkin.js';
import {
  createHangingFetch,
  createUpstreamMock,
  DAILY_PATH,
  DAILY_URL,
  dailyOk,
  jsonRes,
  makeAccount,
  makeCtx,
  STATUS_PATH,
  STATUS_URL,
  statusCheckedIn,
  statusNotCheckedIn,
  textRes,
} from './helpers/harness.mjs';

/** 固定 token（末尾 8 位用于泄漏检测）。 */
const TOKEN = 'super-secret-token-abcdefghijklmnop';
const TOKEN_TAIL = TOKEN.slice(-8);

/**
 * 组装一个「按端点返回响应」的 mock。
 * @param {{status?:Function, daily?:Function}} handlers
 * @returns {Function}
 */
function upstream(handlers) {
  return createUpstreamMock((call) => {
    if (call.path === STATUS_PATH) return handlers.status ? handlers.status(call) : statusNotCheckedIn();
    if (call.path === DAILY_PATH) return handlers.daily ? handlers.daily(call) : dailyOk();
    throw new Error(`未处理的上游端点 ${call.path}`);
  });
}

test('今日已签到：只调 checkin-status，daily-checkin 调用 0 次（AC-8）', async () => {
  const mock = upstream({ status: () => statusCheckedIn(12) });
  const { ctx, kv } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'already_checked_in');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.code, 0);
  assert.equal(result.streakDays, 12);
  assert.equal(result.tokenInvalid, false);
  assert.equal(result.upstreamFatal, false);
  assert.match(result.message, /连续 12 天/);

  assert.equal(mock.count(), 1, '全程只允许 1 次上游调用');
  assert.equal(mock.count(STATUS_PATH), 1);
  assert.equal(mock.count(DAILY_PATH), 0, '已签到绝不能调 daily-checkin');
  assert.equal(kv.writeCount(), 0, '单账号签到逻辑不得写 KV');
});

test('今日未签到：先 status 后 daily，结果 checked_in 且 credit/streak 正确（AC-7）', async () => {
  const mock = upstream({ status: () => statusNotCheckedIn(5), daily: () => dailyOk(10, 6) });
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'checked_in');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.code, 0);
  assert.equal(result.credit, 10);
  assert.equal(result.streakDays, 6);
  assert.match(result.message, /\+10 额度/);
  assert.match(result.message, /连续 6 天/);

  assert.deepEqual(mock.paths(), [STATUS_PATH, DAILY_PATH], '必须严格按 status -> daily 顺序');
  assert.equal(mock.count(DAILY_PATH), 1, 'daily-checkin 恰好 1 次');
});

for (const status of [401, 403]) {
  test(`上游 ${status}：failed + tokenInvalid + 只有 1 次上游调用（AC-9）`, async () => {
    const mock = upstream({ status: () => jsonRes({ code: 401, msg: 'unauthorized' }, status) });
    const { ctx } = makeCtx({ fetch: mock });

    const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

    assert.equal(result.result, 'failed');
    assert.equal(result.tokenInvalid, true, '401/403 必须标记 tokenInvalid');
    assert.equal(result.upstreamFatal, false, 'token 失效不是上游故障，不得标 upstreamFatal');
    assert.equal(result.httpStatus, status);
    assert.match(result.message, new RegExp(`HTTP ${status}`));

    assert.equal(mock.count(), 1, 'token 失效必须短路，不得继续调 daily-checkin');
    assert.equal(mock.count(DAILY_PATH), 0);
  });
}

test('上游 5xx：failed + upstreamFatal（不标记 tokenInvalid）', async () => {
  const mock = upstream({ status: () => jsonRes({ code: 500, msg: 'boom' }, 500) });
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'failed');
  assert.equal(result.upstreamFatal, true);
  assert.equal(result.tokenInvalid, false);
  assert.equal(result.httpStatus, 500);
  assert.match(result.message, /上游服务异常（HTTP 500）/);
  assert.equal(mock.count(), 1);
});

test('上游超时：≤1s 内返回 failed 且 message 含「超时」（AC-19）', async () => {
  const hanging = createHangingFetch();
  const { ctx } = makeCtx({ fetch: hanging });

  const startedAt = Date.now();
  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }), { timeoutMs: 50 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.result, 'failed');
  assert.match(result.message, /超时/);
  assert.equal(result.upstreamFatal, true);
  assert.equal(result.tokenInvalid, false);
  assert.ok(elapsed <= 1000, `超时保护必须在 1s 内返回，实际 ${elapsed}ms`);
  assert.equal(hanging.calls.length, 1, '超时后不得继续发起第二个请求');
});

test('上游响应非 JSON：failed + message「上游响应非 JSON」', async () => {
  const mock = upstream({ status: () => textRes('<html>502 gateway</html>', 200) });
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'failed');
  assert.equal(result.message, '上游响应非 JSON');
  assert.equal(result.upstreamFatal, true);
  assert.equal(mock.count(), 1);
});

test('业务失败（code !== 0）：failed 且带上游 code 与 message', async () => {
  const mock = upstream({ status: () => jsonRes({ code: 7, msg: '额度不足' }, 200) });
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'failed');
  assert.equal(result.code, 7);
  assert.equal(result.tokenInvalid, false);
  assert.equal(result.upstreamFatal, false, '业务失败不是上游故障');
  assert.match(result.message, /code=7/);
  assert.match(result.message, /额度不足/);
});

test('网络错误：failed + upstreamFatal + message 带错误名', async () => {
  const mock = createUpstreamMock(() => {
    const err = new Error('socket hang up');
    err.name = 'TypeError';
    throw err;
  });
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'failed');
  assert.equal(result.upstreamFatal, true);
  assert.match(result.message, /网络错误：TypeError/);
});

test('请求形状：POST / 两个精确 URL / Bearer 头 / application/json / body "{}"', async () => {
  const mock = upstream({});
  const { ctx } = makeCtx({ fetch: mock });

  await checkinAccount(ctx, makeAccount(1, { token: `Bearer   ${TOKEN}` }));

  assert.equal(mock.count(), 2);
  const [statusCall, dailyCall] = mock.calls;

  assert.equal(statusCall.url, STATUS_URL);
  assert.equal(statusCall.url, `${UPSTREAM_BASE}/v2/billing/meter/checkin-status`);
  assert.equal(dailyCall.url, DAILY_URL);
  assert.equal(dailyCall.url, `${UPSTREAM_BASE}/v2/billing/meter/daily-checkin`);

  for (const call of [statusCall, dailyCall]) {
    assert.equal(call.method, 'POST');
    assert.equal(call.contentType, 'application/json');
    assert.equal(call.authorization, `Bearer ${TOKEN}`, '录入口的 Bearer 前缀与空格必须被清洗');
    assert.equal(call.body, '{}');
  }
});

test('裸 token / 单层 Bearer / 多层 Bearer 产生完全相同的请求头', async () => {
  const bare = upstream({});
  const prefixed = upstream({});
  const multi = upstream({});
  await checkinAccount(makeCtx({ fetch: bare }).ctx, makeAccount(1, { token: TOKEN }));
  await checkinAccount(makeCtx({ fetch: prefixed }).ctx, makeAccount(1, { token: `bearer ${TOKEN}` }));
  await checkinAccount(makeCtx({ fetch: multi }).ctx, makeAccount(1, { token: `Bearer Bearer  ${TOKEN}` }));

  assert.equal(bare.calls[0].authorization, prefixed.calls[0].authorization);
  assert.equal(bare.calls[0].authorization, multi.calls[0].authorization);
  assert.equal(bare.calls[0].authorization, `Bearer ${TOKEN}`);
});

test('token 为空时不发请求，直接 failed', async () => {
  const mock = upstream({});
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, { id: 'acc_x', name: '空 token', token: '   ' });

  assert.equal(result.result, 'failed');
  assert.equal(mock.count(), 0, '空 token 不得发起上游请求');
  assert.match(result.message, /Token 为空/);
});

test('token 不泄漏：结果序列化后不含 token 明文或其末 8 位', async () => {
  const scenarios = [
    upstream({ status: () => statusNotCheckedIn(), daily: () => dailyOk() }),
    upstream({ status: () => statusCheckedIn() }),
    upstream({ status: () => jsonRes({ code: 1, msg: 'bad' }, 200) }),
    upstream({ status: () => jsonRes({ code: 401 }, 401) }),
    upstream({ status: () => jsonRes({ code: 500 }, 500) }),
    upstream({ status: () => textRes('not json', 200) }),
  ];

  for (const mock of scenarios) {
    const { ctx } = makeCtx({ fetch: mock });
    const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(TOKEN), false, `结果泄漏了 token 明文：${serialized}`);
    assert.equal(serialized.includes(TOKEN_TAIL), false, `结果泄漏了 token 末 8 位：${serialized}`);
  }
});

test('checkinStatus 只查状态，不产生签到副作用', async () => {
  const mock = upstream({ status: () => statusNotCheckedIn(3) });
  const { ctx, kv } = makeCtx({ fetch: mock });

  const result = await checkinStatus(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'not_checked_in');
  assert.equal(result.streakDays, 3);
  assert.equal(mock.count(DAILY_PATH), 0, 'dryRun 类调用不得触发 daily-checkin');
  assert.equal(kv.writeCount(), 0);
});

test('callUpstream 返回结构化传输结果（httpStatus/json/error/durationMs）', async () => {
  const mock = upstream({ status: () => jsonRes({ code: 0, data: { today_checked_in: true } }) });
  const { ctx } = makeCtx({ fetch: mock });

  const call = await callUpstream(ctx, STATUS_PATH, TOKEN);

  assert.equal(call.httpStatus, 200);
  assert.equal(call.error, null);
  assert.equal(call.json.code, 0);
  assert.equal(call.json.data.today_checked_in, true);
  assert.equal(typeof call.durationMs, 'number');
  assert.ok(call.durationMs >= 0);
});
