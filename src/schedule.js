// src/schedule.js
// 签到调度：把「每天几点签到」翻译成「这一轮 cron 该不该干活」。
//
// 为什么不是「一个 cron 精确打在 HH:MM」：
//   Cloudflare Cron 只有到分钟的表达力，但 Worker 的 cron 触发并不保证准点
//   （边缘调度与实例冷启动都可能带来分钟级延迟），单点触发一旦错过就整天不签。
//   所以改成 *​/15 高频轮询 + 按「小时」判断归属：
//     - 目标小时内的 4 次触发（:00 :15 :30 :45）都算这一轮窗口；
//     - 第一次成功就把结果写进 KV，后面 3 次直接跳过（零写）；
//     - 第一次失败则后 3 次自动成为重试机会，天然容错。
//
// 时区口径：面板上填的是**北京时间（Asia/Shanghai）的小时数**，与 Cron 的 UTC 表达式解耦。
// 北京不实行夏令时，所以这里不需要处理 DST 跳变。

/** 视为「今天这个账号已经不用再签」的结果集合。 */
export const DONE_RESULTS = Object.freeze(['checked_in', 'already_checked_in']);

/** 是否属于「已完成」集合。 */
const DONE_SET = new Set(DONE_RESULTS);

/** 默认签到小时（北京时间 8 点）。 */
export const DEFAULT_CHECKIN_HOUR = 8;

/** cron 轮询间隔（分钟），与 wrangler.toml 的每 15 分钟轮询保持一致。 */
export const CRON_INTERVAL_MINUTES = 15;

/** 一天有多少分钟，用于把小时换算成 UTC cron 表达式。 */
const MINUTES_PER_DAY = 24 * 60;

/**
 * 把毫秒时间戳换算成北京时间的日期与小时。
 * @param {number} ms
 * @returns {{date:string, hour:number}} date 形如 `2026-11-14`，hour 为 0~23
 */
export function beijingParts(ms) {
  const t = Number.isFinite(ms) ? ms : 0;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date(t));
    const pick = (type) => (parts.find((item) => item.type === type)?.value || '');
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    // 'en-CA' 的 hour 在 24 点场景会给出 '24'，归一成 0
    const rawHour = Number(pick('hour'));
    const hour = Number.isFinite(rawHour) ? (rawHour === 24 ? 0 : rawHour) : 0;
    if (year && month && day) return { date: `${year}-${month}-${day}`, hour };
  } catch {
    // Intl 不可用时走 UTC 兜底（不应发生，Workers 运行时带 full ICU）
  }
  const fallback = new Date(t);
  const iso = fallback.toISOString();
  return { date: iso.slice(0, 10), hour: fallback.getUTCHours() };
}

/**
 * 当前这一轮 cron 是否落在配置的签到小时内。
 * @param {{checkinHour?:number}} settings
 * @param {number} ms
 * @returns {boolean}
 */
export function isCheckinHour(settings, ms) {
  const raw = settings && typeof settings === 'object' ? settings.checkinHour : undefined;
  const target = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_CHECKIN_HOUR;
  return beijingParts(ms).hour === target;
}

/**
 * 换算某个北京时间小时对应的 UTC cron 表达式（仅用于面板展示与排错）。
 * @param {number} checkinHour 北京时间 0~23
 * @returns {{cronUtc:string, cronLocal:string}}
 */
export function deriveCronTexts(checkinHour) {
  const hour = Number.isFinite(checkinHour) ? ((Math.trunc(checkinHour) % 24) + 24) % 24 : DEFAULT_CHECKIN_HOUR;
  const utcHour = ((hour - 8) % 24 + 24) % 24;
  return {
    // 实际部署表达式是高频轮询，这里给出「该小时在 UTC 里对应几点」以便人工核对
    cronUtc: `${String(utcHour).padStart(2, '0')}:00`,
    cronLocal: `${String(hour).padStart(2, '0')}:00`,
  };
}

/**
 * 把 cron 轮询换算成「每 N 分钟」的表达（供面板与文档展示）。
 * @returns {number}
 */
export function cronIntervalMinutes() {
  return CRON_INTERVAL_MINUTES;
}

/**
 * 算出这一轮需要签到的账号 id。
 * 规则：
 *   - 当天的记录日期不是今天 -> 全部待签；
 *   - 是今天 -> 排除已成功（checked_in / already_checked_in）的账号；
 *   - 失败结果不写入记录，所以失败账号天然会被重试。
 * @param {object[]} accounts 已启用账号
 * @param {{date?:string, accounts?:Record<string,{result?:string}>}|null} dayRecord
 * @param {string} date 北京时间日期 `YYYY-MM-DD`
 * @returns {string[]}
 */
export function pendingAccountIds(accounts, dayRecord, date) {
  const list = Array.isArray(accounts) ? accounts.filter((item) => item && typeof item.id === 'string' && item.id) : [];
  const record = dayRecord && typeof dayRecord === 'object' ? dayRecord : null;
  const sameDay = Boolean(record && record.date === date);
  const doneMap = sameDay && record.accounts && typeof record.accounts === 'object' ? record.accounts : null;
  if (!doneMap) return list.map((account) => account.id);
  return list
    .filter((account) => {
      const hit = doneMap[account.id];
      return !(hit && typeof hit === 'object' && DONE_SET.has(hit.result));
    })
    .map((account) => account.id);
}

/**
 * 把本次 run 的成功结果合并进当日记录。
 * 只记成功：失败不入库，才会被后续几轮重试捞起来。
 * @param {{date?:string, accounts?:object}|null} dayRecord 旧记录
 * @param {string} date 北京时间日期
 * @param {object[]} entries runCheckin 的 entries
 * @param {string} nowIso 写入时刻（ISO）
 * @returns {object|null} 新的记录；没有任何成功（且无历史）时返回 null，表示不必写
 */
export function mergeDayRecord(dayRecord, date, entries, nowIso) {
  const record = dayRecord && typeof dayRecord === 'object' && dayRecord.date === date ? dayRecord : null;
  const accounts = record && record.accounts && typeof record.accounts === 'object'
    ? { ...record.accounts }
    : {};
  let changed = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.accountId !== 'string' || !entry.accountId) continue;
    if (!DONE_SET.has(entry.result)) continue;
    const prev = accounts[entry.accountId];
    if (prev && prev.result === entry.result) continue;
    accounts[entry.accountId] = { result: entry.result, at: nowIso };
    changed = true;
  }
  if (!changed && record) return null;
  if (!changed && Object.keys(accounts).length === 0) return null;
  return { date, accounts, updatedAt: nowIso };
}

/**
 * 当日记录是否已经覆盖所有启用账号（用于「零写提前返回」）。
 * @param {object[]} accounts 已启用账号
 * @param {{date?:string, accounts?:object}|null} dayRecord
 * @param {string} date
 * @returns {boolean}
 */
export function isDayComplete(accounts, dayRecord, date) {
  return pendingAccountIds(accounts, dayRecord, date).length === 0;
}

/** 供外部复用的「已完成」判定。 */
export function isDoneResult(result) {
  return DONE_SET.has(result);
}

/** 一天分钟数常量导出（测试与文档用）。 */
export { MINUTES_PER_DAY };
