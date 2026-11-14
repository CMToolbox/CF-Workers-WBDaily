// src/checkin.js
// 上游客户端：AbortController 超时控制 + 两段式签到（先 status 后 daily）+ 错误归一化。
// 约束：不得访问 env、不得调用全局 fetch、不得调用 Date.now()（全部经 ctx 注入）。
// 安全：任何 message 都可能进入日志与面板，**永不包含 token 或其片段**。

import { sanitizeToken, truncate } from './util.js';

/** 上游基址。 */
export const UPSTREAM_BASE = 'https://copilot.tencent.com';

/** 今日签到状态查询路径。 */
const STATUS_PATH = '/v2/billing/meter/checkin-status';

/** 执行签到的路径。 */
const DAILY_PATH = '/v2/billing/meter/daily-checkin';

/** 单次上游请求默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 10000;

/** message 字符上限。 */
const MESSAGE_MAX_CHARS = 200;

/**
 * 取数字字段，非法返回 null（0 合法）。
 * @param {*} value
 * @returns {number|null}
 */
function toNumber(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * 取上游业务数据体（{code, data, msg}）。
 * @param {*} json
 * @returns {object}
 */
function pickData(json) {
  if (!json || typeof json !== 'object') return {};
  const data = json.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * 取上游业务提示文本。
 * @param {*} json
 * @returns {string}
 */
function pickUpstreamMessage(json) {
  if (!json || typeof json !== 'object') return '';
  const candidate = typeof json.msg === 'string' ? json.msg : typeof json.message === 'string' ? json.message : '';
  return candidate;
}

/**
 * 判断上游业务是否成功（code === 0）。
 * @param {*} json
 * @returns {boolean}
 */
function isBusinessOk(json) {
  return !!json && typeof json === 'object' && json.code === 0;
}

/**
 * 组装统一的 failed 结果。
 * @param {{httpStatus?:number, code?:number|null, message:string, tokenInvalid?:boolean,
 *          upstreamFatal?:boolean, durationMs?:number, credit?:number|null,
 *          streakDays?:number|null}} partial
 * @returns {object} CheckinResult
 */
function failed(partial) {
  const src = partial || {};
  return {
    result: 'failed',
    httpStatus: Number.isFinite(src.httpStatus) ? src.httpStatus : 0,
    code: Number.isFinite(src.code) ? src.code : null,
    message: truncate(typeof src.message === 'string' ? src.message : '', MESSAGE_MAX_CHARS),
    credit: Number.isFinite(src.credit) ? src.credit : null,
    streakDays: Number.isFinite(src.streakDays) ? src.streakDays : null,
    durationMs: Number.isFinite(src.durationMs) ? src.durationMs : 0,
    tokenInvalid: src.tokenInvalid === true,
    upstreamFatal: src.upstreamFatal === true,
  };
}

/**
 * 上游调用：POST 空 JSON body，带 Bearer token，AbortController 控超时。
 * @param {object} ctx
 * @param {string} path 以 `/` 开头
 * @param {string} token 裸 token
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{httpStatus:number, json:any, error:null|'TIMEOUT'|'NETWORK'|'BAD_JSON',
 *                    durationMs:number, errorName:string|null}>}
 */
export async function callUpstream(ctx, path, token, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const url = `${UPSTREAM_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const startedAtMs = ctx.now();
  const controller = new AbortController();

  let httpStatus = 0;
  let json = null;
  let error = null;
  let errorName = null;
  let timer = null;

  // 超时兜底：既 abort 请求，也用一个必然 reject 的 Promise 参与竞速。
  // 这样即使底层 fetch 实现忽略 signal（例如单测里的 mock 永不 resolve），也能按时返回 TIMEOUT。
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* abort 失败无需处理 */
      }
      const timeoutError = new Error('upstream timeout');
      timeoutError.name = 'TimeoutError';
      reject(timeoutError);
    }, timeoutMs);
  });

  const requestPromise = (async () => {
    const response = await ctx.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: '{}',
      signal: controller.signal,
    });
    const status = Number.isFinite(response && response.status) ? response.status : 0;
    let parsed = null;
    let parseFailed = false;
    try {
      parsed = await response.json();
    } catch (parseError) {
      const name = parseError && parseError.name ? String(parseError.name) : '';
      if (name === 'AbortError' || name === 'TimeoutError') throw parseError;
      parseFailed = true;
    }
    return { status, parsed, parseFailed };
  })();
  // 超时竞速结束后，迟到的 reject 不应变成 unhandled rejection
  requestPromise.catch(() => {});

  try {
    const result = await Promise.race([requestPromise, timeoutPromise]);
    httpStatus = result.status;
    if (result.parseFailed) {
      json = null;
      // 非 2xx 时 body 解析失败不算 BAD_JSON，交由上层按 httpStatus 判定
      error = httpStatus >= 200 && httpStatus < 300 ? 'BAD_JSON' : null;
    } else {
      json = result.parsed;
    }
  } catch (err) {
    const name = err && err.name ? String(err.name) : '';
    errorName = name || 'Error';
    if (name === 'AbortError' || name === 'TimeoutError') {
      error = 'TIMEOUT';
    } else {
      error = 'NETWORK';
    }
    json = null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  return {
    httpStatus,
    json,
    error,
    durationMs: Math.max(0, ctx.now() - startedAtMs),
    errorName,
  };
}

/**
 * 把传输层错误 / HTTP 状态归一化成 failed 结果；无错误返回 null。
 * 顺序即 ARCHITECTURE §8 的优先级：超时/网络/非 JSON 先于 HTTP 状态判定，
 * 401/403 在 status 阶段就必须短路（调用方据此不再发起 daily-checkin）。
 * @param {{httpStatus:number, error:string|null, errorName:string|null}} call
 * @returns {object|null}
 */
function classifyTransportError(call) {
  const httpStatus = Number.isFinite(call.httpStatus) ? call.httpStatus : 0;
  if (call.error === 'TIMEOUT') {
    return failed({ httpStatus, message: '上游超时（10s）', upstreamFatal: true });
  }
  if (call.error === 'NETWORK') {
    return failed({ httpStatus, message: `网络错误：${call.errorName || 'Error'}`, upstreamFatal: true });
  }
  if (call.error === 'BAD_JSON') {
    return failed({ httpStatus, message: '上游响应非 JSON', upstreamFatal: true });
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return failed({ httpStatus, message: `Token 已失效（HTTP ${httpStatus}）`, tokenInvalid: true });
  }
  if (httpStatus === 429) {
    return failed({ httpStatus, message: '上游限流（HTTP 429），请稍后再试' });
  }
  if (httpStatus >= 500) {
    return failed({ httpStatus, message: `上游服务异常（HTTP ${httpStatus}）`, upstreamFatal: true });
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return failed({ httpStatus, message: `上游请求失败（HTTP ${httpStatus}）` });
  }
  return null;
}

/**
 * 业务失败（HTTP 2xx 但 code !== 0）。
 * @param {*} json
 * @param {number} httpStatus
 * @returns {object}
 */
function classifyBusinessError(json, httpStatus) {
  const code = json && typeof json === 'object' && Number.isFinite(json.code) ? json.code : null;
  const upstreamMessage = pickUpstreamMessage(json);
  return failed({
    httpStatus,
    code,
    message: `上游业务失败 code=${code === null ? 'unknown' : code}: ${upstreamMessage || '未知'}`,
  });
}

/**
 * 只查询今日签到状态（不产生签到副作用），供 dryRun / 状态类接口复用。
 * @param {object} ctx
 * @param {object} account
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<object>} result ∈ already_checked_in | not_checked_in | failed
 */
export async function checkinStatus(ctx, account, options = {}) {
  const acc = account && typeof account === 'object' ? account : {};
  const token = sanitizeToken(acc.token);
  if (!token) {
    return failed({ message: 'Token 为空，请在面板重新填写' });
  }
  const call = await callUpstream(ctx, STATUS_PATH, token, options);
  const transport = classifyTransportError(call);
  if (transport) return { ...transport, durationMs: call.durationMs };
  if (!isBusinessOk(call.json)) return { ...classifyBusinessError(call.json, call.httpStatus), durationMs: call.durationMs };

  const data = pickData(call.json);
  const streakDays = toNumber(data.streak_days === undefined ? data.streakDays : data.streak_days);
  const streakText = streakDays === null ? 0 : streakDays;
  if (data.today_checked_in === true) {
    return {
      result: 'already_checked_in',
      httpStatus: call.httpStatus,
      code: 0,
      message: truncate(`今日已签到，连续 ${streakText} 天`, MESSAGE_MAX_CHARS),
      credit: null,
      streakDays,
      durationMs: call.durationMs,
      tokenInvalid: false,
      upstreamFatal: false,
    };
  }
  return {
    result: 'not_checked_in',
    httpStatus: call.httpStatus,
    code: 0,
    message: truncate('今日尚未签到', MESSAGE_MAX_CHARS),
    credit: null,
    streakDays,
    durationMs: call.durationMs,
    tokenInvalid: false,
    upstreamFatal: false,
  };
}

/**
 * 执行单账号签到：先查 status，已签到则幂等跳过；否则调 daily-checkin。
 * 严格按 ARCHITECTURE §8 的九类分支。
 * @param {object} ctx
 * @param {object} account Account（含 token）
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{result:'checked_in'|'already_checked_in'|'failed',
 *                    httpStatus:number, code:number|null, message:string,
 *                    credit:number|null, streakDays:number|null,
 *                    durationMs:number, tokenInvalid:boolean, upstreamFatal:boolean}>}
 */
export async function checkinAccount(ctx, account, options = {}) {
  const acc = account && typeof account === 'object' ? account : {};
  const token = sanitizeToken(acc.token);
  const startedAtMs = ctx.now();
  const elapsed = () => Math.max(0, ctx.now() - startedAtMs);

  if (!token) {
    return { ...failed({ message: 'Token 为空，请在面板重新填写' }), durationMs: elapsed() };
  }

  // 第一段：查询今日签到状态
  const statusCall = await callUpstream(ctx, STATUS_PATH, token, options);
  const statusTransport = classifyTransportError(statusCall);
  if (statusTransport) return { ...statusTransport, durationMs: elapsed() };
  if (!isBusinessOk(statusCall.json)) {
    return { ...classifyBusinessError(statusCall.json, statusCall.httpStatus), durationMs: elapsed() };
  }

  const statusData = pickData(statusCall.json);
  const statusStreak = toNumber(statusData.streak_days === undefined ? statusData.streakDays : statusData.streak_days);
  if (statusData.today_checked_in === true) {
    // 幂等：已签到绝不调用 daily-checkin
    return {
      result: 'already_checked_in',
      httpStatus: statusCall.httpStatus,
      code: 0,
      message: truncate(`今日已签到，连续 ${statusStreak === null ? 0 : statusStreak} 天`, MESSAGE_MAX_CHARS),
      credit: null,
      streakDays: statusStreak,
      durationMs: elapsed(),
      tokenInvalid: false,
      upstreamFatal: false,
    };
  }

  // 第二段：执行签到
  const dailyCall = await callUpstream(ctx, DAILY_PATH, token, options);
  const dailyTransport = classifyTransportError(dailyCall);
  if (dailyTransport) return { ...dailyTransport, durationMs: elapsed() };
  if (!isBusinessOk(dailyCall.json)) {
    return { ...classifyBusinessError(dailyCall.json, dailyCall.httpStatus), durationMs: elapsed() };
  }

  const dailyData = pickData(dailyCall.json);
  const credit = toNumber(dailyData.credit);
  const streakDays = toNumber(dailyData.streak_days === undefined ? dailyData.streakDays : dailyData.streak_days);
  return {
    result: 'checked_in',
    httpStatus: dailyCall.httpStatus,
    code: 0,
    message: truncate(
      `签到成功，+${credit === null ? 0 : credit} 额度，连续 ${streakDays === null ? 0 : streakDays} 天`,
      MESSAGE_MAX_CHARS,
    ),
    credit,
    streakDays,
    durationMs: elapsed(),
    tokenInvalid: false,
    upstreamFatal: false,
  };
}
