// test/frontend-badge-schedule.test.mjs
// 前端无构建、无 DOM 环境：沿用 test/frontend-filename.test.mjs 的做法，
// 用正则从 public/app.js 源码里**原样抽取**函数体，在 Function 沙箱里注入依赖后求值。
// 零新依赖、不引入 jsdom、不改动 public/app.js —— 验证的是生产代码本身，不会与实现漂移。
//
// 覆盖两处日期语义修复：
//   B2 状态徽标必须按「北京日期」过滤 run（昨天 20:37 的 already_checked_in 不得显示成「今日已签」）
//   B5 KPI「下次自动签到」不无条件追加「明天」（只有该小时已过才顺延）
// 外加 B1 / B3 的静态守卫断言。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP_PATH = new URL('../public/app.js', import.meta.url);
const CSS_PATH = new URL('../public/styles.css', import.meta.url);
const CREDITS_PATH = new URL('../src/credits.js', import.meta.url);

/**
 * 读取源码文本并统一换行符。
 * 仓库在 Windows 上检出为 CRLF，若直接对 `\n  position: sticky;` 这类多行锚点做断言会假失败 ——
 * 断言只针对代码内容，不该被平台换行干扰。
 * @param {URL} path
 * @returns {string}
 */
function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 去掉整行注释，只留代码行。
 * 用途：B3 的字段删除允许保留说明性注释，断言语义应该是「代码里不再引用」而不是「文本里不出现」。
 * @param {string} src
 * @returns {string}
 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

/** 读取 public/app.js 源码文本。 */
function readApp() {
  return readText(APP_PATH);
}

/** 读取 public/styles.css 源码文本。 */
function readCss() {
  return readText(CSS_PATH);
}

/**
 * 从 public/app.js 里抽出一个具名函数的源码（含 function 关键字到列 0 的闭括号）。
 * @param {string} name 函数名
 * @returns {string}
 */
function functionSource(name) {
  const pattern = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
  const matched = pattern.exec(readApp());
  assert.ok(matched, `public/app.js 里必须仍存在函数 ${name}`);
  return matched[0];
}

/**
 * 把抽取到的函数放到「显式依赖」的沙箱里求值：所有自由变量都由 deps 注入，
 * 因此可以把「现在是几点」「state.logs 是什么」全部固定下来，不依赖真机时钟。
 * @param {Record<string, *>} deps 自由变量名 -> 值
 * @param {string} name 函数名
 * @returns {Function}
 */
function evalWith(deps, name) {
  const keys = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...keys, `return (${functionSource(name)});`);
  return factory(...keys.map((key) => deps[key]));
}

/** 从 public/app.js 里取出 CLOCK_FMT 这个 Intl 实例（复用生产定义，避免另写一份时区配置）。 */
function extractClockFmt() {
  const matched = /const CLOCK_FMT = new Intl\.DateTimeFormat\('zh-CN', \{[\s\S]*?\}\);/.exec(readApp());
  assert.ok(matched, 'public/app.js 里必须仍存在 CLOCK_FMT');
  // eslint-disable-next-line no-new-func
  return new Function(`${matched[0]}\nreturn CLOCK_FMT;`)();
}

// ============ 时间锚点（全部写成带 +08:00 的绝对时刻，与机器时区无关） ============

/** 「现在」= 北京 2026-11-15 02:00（真机 bug 场景的同一时刻）。 */
const NOW_BJ_1115_0200 = new Date('2026-11-15T02:00:00+08:00');
/** run 发生在北京 2026-11-14 20:37（= UTC 12:37）。 */
const RUN_BJ_1114_2037 = '2026-11-14T12:37:00.000Z';
/** run 发生在北京 2026-11-14 23:59（= UTC 15:59，跨天前一秒）。 */
const RUN_BJ_1114_2359 = '2026-11-14T15:59:00.000Z';
/** run 发生在北京 2026-11-15 00:00（= UTC 16:00，刚好跨到「今天」）。 */
const RUN_BJ_1115_0000 = '2026-11-14T16:00:00.000Z';
/** run 发生在北京 2026-11-15 09:00。 */
const RUN_BJ_1115_0900 = '2026-11-15T01:00:00.000Z';

/**
 * 构造一个 latestRunTodayFor 沙箱。
 * fmtDateStamp 的默认参数被替换成固定的「现在」，等价于把真机时钟钉在 now 上，
 * 但内部仍然走生产代码里的 Asia/Shanghai 换算（不是复制一份逻辑）。
 * @param {{logs:object[], now?:Date}} params
 * @returns {Function} latestRunTodayFor
 */
function makeTodayFilter({ logs, now = NOW_BJ_1115_0200 }) {
  const realFmtDateStamp = evalWith({}, 'fmtDateStamp');
  const fmtDateStamp = (date = now) => realFmtDateStamp(date);
  return evalWith({ state: { logs }, fmtDateStamp }, 'latestRunTodayFor');
}

/**
 * 构造 statusBadge 沙箱：el 用假的（返回 {tag, cls, text}），其余全用生产代码。
 * @param {{logs:object[], accounts:object[], credits?:object, now?:Date}} params
 * @returns {Function} statusBadge
 */
function makeStatusBadge({ logs, accounts, credits = {}, now = NOW_BJ_1115_0200 }) {
  const realFmtDateStamp = evalWith({}, 'fmtDateStamp');
  const fmtDateStamp = (date = now) => realFmtDateStamp(date);
  const state = { logs, accounts, credits };
  const fakeEl = (tag, className, text) => ({
    tag,
    cls: className || '',
    text: text === undefined || text === null ? '' : String(text),
  });
  const latestRunFor = evalWith({ state }, 'latestRunFor');
  const latestRunTodayFor = evalWith({ state, fmtDateStamp }, 'latestRunTodayFor');
  const resultBadge = evalWith({ el: fakeEl }, 'resultBadge');
  return evalWith(
    { el: fakeEl, state, latestRunTodayFor, latestRunFor, resultBadge },
    'statusBadge',
  );
}

/**
 * 构造 nextCheckinInfo 沙箱。
 * nextCheckinInfo 内部是**无参**调用 beijingMinuteOfDay()，而后者默认 new Date()。
 * 为了不依赖真机时钟，这里注入一个「带固定分钟数」的替代实现：
 * 无参调用返回注入值，带参调用仍走生产实现（保证两种调用口径都被覆盖）。
 * @param {{accounts:object[], minuteOfDay:number}} params
 * @returns {Function} nextCheckinInfo
 */
function makeNextCheckinInfo({ accounts, minuteOfDay }) {
  const realMinuteOfDay = evalWith({ CLOCK_FMT: extractClockFmt() }, 'beijingMinuteOfDay');
  const beijingMinuteOfDay = (date) => (date === undefined ? minuteOfDay : realMinuteOfDay(date));
  const nextCheckinHour = evalWith({ state: { accounts } }, 'nextCheckinHour');
  return evalWith({ nextCheckinHour, beijingMinuteOfDay }, 'nextCheckinInfo');
}

// ============ 时间锚点自检：先证明锚点算出来的北京日期符合预期 ============

test('时间锚点自检：fmtDateStamp 按 Asia/Shanghai 换算，与机器时区无关', () => {
  const fmtDateStamp = evalWith({}, 'fmtDateStamp');
  // 20:37Z 之后的 12:37Z 是北京 20:37 当天；16:00Z 是北京次日 00:00
  assert.equal(fmtDateStamp(new Date(RUN_BJ_1114_2037)), '2026-11-14');
  assert.equal(fmtDateStamp(new Date(RUN_BJ_1114_2359)), '2026-11-14');
  assert.equal(fmtDateStamp(new Date(RUN_BJ_1115_0000)), '2026-11-15');
  assert.equal(fmtDateStamp(NOW_BJ_1115_0200), '2026-11-15');
});

// ============ B2：latestRunTodayFor 的日期过滤 ============

test('latestRunTodayFor：昨天 20:37 的 run 不算今天（真机 bug 场景）', () => {
  const latestRunTodayFor = makeTodayFilter({
    logs: [{
      startedAt: RUN_BJ_1114_2037,
      accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }],
    }],
  });
  // 北京时间 11-15 02:00 看「昨天 20:37 的已签」——必须为 null，否则卡片会谎报「今日已签」
  assert.equal(latestRunTodayFor('acc_1'), null);
});

test('latestRunTodayFor：今天 00:00 的 run 命中', () => {
  const latestRunTodayFor = makeTodayFilter({
    logs: [{
      startedAt: RUN_BJ_1115_0000,
      accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }],
    }],
  });
  assert.deepEqual(latestRunTodayFor('acc_1'), {
    result: 'already_checked_in',
    startedAt: RUN_BJ_1115_0000,
  });
});

test('latestRunTodayFor：昨天 23:59 vs 今天 00:00 —— 跨分钟边界只差 1 分钟也不同天', () => {
  const logs = [
    { startedAt: RUN_BJ_1115_0000, accountResults: [{ accountId: 'acc_1', result: 'skipped_disabled' }] },
    { startedAt: RUN_BJ_1114_2359, accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }] },
  ];
  const latestRunTodayFor = makeTodayFilter({ logs });
  // 只认 00:00 那条；23:59 那条同属 acc_1 但必须被日期过滤掉
  assert.equal(latestRunTodayFor('acc_1').startedAt, RUN_BJ_1115_0000);
  assert.equal(latestRunTodayFor('acc_1').result, 'skipped_disabled');

  // 反过来：只有昨天 23:59 那条时必须为 null
  const onlyYesterday = makeTodayFilter({ logs: [logs[1]] });
  assert.equal(onlyYesterday('acc_1'), null);
});

test('latestRunTodayFor：startedAt 非法 / 缺失时跳过而不是抛错', () => {
  const logs = [
    { startedAt: 'not-a-date', accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    { startedAt: '', accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    { startedAt: undefined, accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    null,
    { accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    { startedAt: RUN_BJ_1115_0900, accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
  ];
  const latestRunTodayFor = makeTodayFilter({ logs });
  // 脏数据被跳过，最终命中今天 09:00 那条（整个过程不得抛异常）
  assert.equal(latestRunTodayFor('acc_1').result, 'checked_in');
  assert.equal(latestRunTodayFor('acc_1').startedAt, RUN_BJ_1115_0900);

  // 全部非法 -> null，仍然不抛
  const allBad = makeTodayFilter({ logs: logs.slice(0, 5) });
  assert.equal(allBad('acc_1'), null);
});

test('latestRunTodayFor：state.logs 是「新 -> 旧」，取今天里最新的一条', () => {
  const logs = [
    { startedAt: RUN_BJ_1115_0900, accountResults: [{ accountId: 'acc_1', result: 'failed' }] },
    { startedAt: RUN_BJ_1115_0000, accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    { startedAt: RUN_BJ_1114_2037, accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }] },
  ];
  const latestRunTodayFor = makeTodayFilter({ logs });
  assert.equal(latestRunTodayFor('acc_1').result, 'failed');
  // 昨天那条「已签」不会盖住今天的「失败」
  assert.notEqual(latestRunTodayFor('acc_1').result, 'already_checked_in');
});

test('latestRunTodayFor：只返回该账号自己的结果，不串账号', () => {
  const logs = [{
    startedAt: RUN_BJ_1115_0900,
    accountResults: [
      { accountId: 'acc_1', result: 'checked_in' },
      { accountId: 'acc_2', result: 'failed' },
    ],
  }];
  const latestRunTodayFor = makeTodayFilter({ logs });
  assert.equal(latestRunTodayFor('acc_1').result, 'checked_in');
  assert.equal(latestRunTodayFor('acc_2').result, 'failed');
  assert.equal(latestRunTodayFor('acc_404'), null);
});

// ============ B2：statusBadge 的三态渲染 ============

test('statusBadge：昨天 20:37 的 already_checked_in 必须渲染成「未签到」，不能是「今日已签」', () => {
  const statusBadge = makeStatusBadge({
    accounts: [{ id: 'acc_1', name: '账号1', enabled: true }],
    logs: [{
      startedAt: RUN_BJ_1114_2037,
      accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }],
    }],
  });
  const badge = statusBadge({ id: 'acc_1', name: '账号1', enabled: true });
  assert.equal(badge.text, '未签到');
  assert.equal(badge.cls, 'badge badge-mute');
  assert.notEqual(badge.text, '今日已签', '这正是被修复的 bug：跨天的已签状态不得延续到今天');
});

test('statusBadge：今天 09:00 的 checked_in 渲染成「签到成功」', () => {
  const statusBadge = makeStatusBadge({
    accounts: [{ id: 'acc_1', name: '账号1', enabled: true }],
    logs: [{
      startedAt: RUN_BJ_1115_0900,
      accountResults: [{ accountId: 'acc_1', result: 'checked_in' }],
    }],
  });
  const badge = statusBadge({ id: 'acc_1', name: '账号1', enabled: true });
  assert.equal(badge.text, '签到成功');
  assert.equal(badge.cls, 'badge badge-ok');
});

test('statusBadge：从未跑过 -> 「未跑过」；今天没有但历史跑过 -> 「未签到」', () => {
  const account = { id: 'acc_1', name: '账号1', enabled: true };
  const never = makeStatusBadge({ accounts: [account], logs: [] });
  assert.equal(never(account).text, '未跑过');
  assert.equal(never(account).cls, 'badge badge-mute');

  const historical = makeStatusBadge({
    accounts: [account],
    logs: [{ startedAt: RUN_BJ_1114_2037, accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] }],
  });
  assert.equal(historical(account).text, '未签到');
  assert.equal(historical(account).cls, 'badge badge-mute');
});

test('statusBadge：禁用 / token 失效的优先级高于日期过滤', () => {
  const logs = [{
    startedAt: RUN_BJ_1115_0900,
    accountResults: [{ accountId: 'acc_1', result: 'checked_in' }],
  }];
  const disabled = makeStatusBadge({
    accounts: [{ id: 'acc_1', name: '账号1', enabled: false }],
    logs,
  });
  assert.equal(disabled({ id: 'acc_1', name: '账号1', enabled: false }).text, '已禁用');

  const tokenBad = makeStatusBadge({
    accounts: [{ id: 'acc_1', name: '账号1', enabled: true }],
    logs,
    credits: { acc_1: { error: { tokenInvalid: true, message: 'Token 已过期' } } },
  });
  const badge = tokenBad({ id: 'acc_1', name: '账号1', enabled: true });
  assert.equal(badge.text, 'token 失效');
  assert.equal(badge.cls, 'badge badge-bad');
});

// ============ B5：beijingMinuteOfDay + nextCheckinInfo ============

test('beijingMinuteOfDay：北京时刻换算成当天第几分钟', () => {
  const beijingMinuteOfDay = evalWith({ CLOCK_FMT: extractClockFmt() }, 'beijingMinuteOfDay');
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T00:00:00+08:00')), 0);
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T02:00:00+08:00')), 120);
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T08:00:00+08:00')), 480);
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T09:30:00+08:00')), 570);
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T23:59:00+08:00')), 1439);
});

test('nextCheckinInfo：北京 02:00 + hour 8 -> 今天（不带「明天」）', () => {
  const nextCheckinInfo = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: true, checkinHour: 8 }],
    minuteOfDay: 2 * 60,
  });
  assert.deepEqual(nextCheckinInfo(), { hour: 8, isTomorrow: false });
});

test('nextCheckinInfo：北京 09:30 + hour 8 -> 明天', () => {
  const nextCheckinInfo = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: true, checkinHour: 8 }],
    minuteOfDay: 9 * 60 + 30,
  });
  assert.deepEqual(nextCheckinInfo(), { hour: 8, isTomorrow: true });
});

test('nextCheckinInfo：北京 08:00 整 + hour 8 -> 明天（口径是「严格大于」，08:00 这轮已在跑）', () => {
  // 已文档化口径：isTomorrow = hour*60 <= 当前分钟数。
  // 恰好等于 480 时判为「明天」，避免 08:00 时提示「今天 08:00」这种已经发生过的自我指涉。
  const nextCheckinInfo = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: true, checkinHour: 8 }],
    minuteOfDay: 8 * 60,
  });
  assert.deepEqual(nextCheckinInfo(), { hour: 8, isTomorrow: true });
});

test('nextCheckinInfo：北京 07:59 + hour 8 -> 今天（差一分钟仍属今天）', () => {
  const nextCheckinInfo = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: true, checkinHour: 8 }],
    minuteOfDay: 8 * 60 - 1,
  });
  assert.deepEqual(nextCheckinInfo(), { hour: 8, isTomorrow: false });
});

test('nextCheckinInfo：取启用账号里最早的小时；无启用账号 -> null', () => {
  const nextCheckinInfo = makeNextCheckinInfo({
    accounts: [
      { id: 'acc_1', enabled: true, checkinHour: 9 },
      { id: 'acc_2', enabled: true, checkinHour: 8 },
      { id: 'acc_3', enabled: false, checkinHour: 6 },
    ],
    minuteOfDay: 2 * 60,
  });
  assert.deepEqual(nextCheckinInfo(), { hour: 8, isTomorrow: false });

  const noneEnabled = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: false, checkinHour: 8 }],
    minuteOfDay: 2 * 60,
  });
  assert.equal(noneEnabled(), null, '没有启用账号时 KPI 必须显示 —');

  const empty = makeNextCheckinInfo({ accounts: [], minuteOfDay: 2 * 60 });
  assert.equal(empty(), null);
});

// ============ B3：字段移除的静态守卫 ============

/**
 * 找出 app.js 里所有含某个 token 的行，返回 {line, text, isComment}。
 * 用途：允许注释里出现说明文字，但**代码**里不许再渲染该字段。
 * @param {string} token
 * @returns {{line:number, text:string, isComment:boolean}[]}
 */
function findTokenLines(token) {
  return readApp()
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter((item) => item.text.includes(token))
    .map((item) => {
      const trimmed = item.text.trim();
      return { ...item, isComment: trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') };
    });
}

test('B3 静态守卫：public/app.js 里 switchAt 只允许出现在注释中', () => {
  const hits = findTokenLines('switchAt');
  assert.ok(hits.length > 0, '应当保留说明性注释，便于后人理解为什么删了');
  for (const hit of hits) {
    assert.equal(
      hit.isComment,
      true,
      `public/app.js:${hit.line} 仍在代码里使用 switchAt：${hit.text.trim()}`,
    );
  }
});

test('B3 静态守卫：public/app.js 不再有 credit-switch 与「切换时间」渲染文案', () => {
  const src = readApp();
  assert.equal(src.includes('credit-switch'), false, 'credit-switch 类名不应再出现在 app.js');
  assert.equal(src.includes('切换时间：'), false, '不得再有「切换时间：」的展示模板（全角冒号）');
  assert.equal(src.includes('积分切换时间 '), false, '不得再有「积分切换时间 xxx」的展示模板（带尾空格）');
  // 模板字符串形式的渲染也要断掉
  assert.equal(/`切换时间[^`]*\$\{/.test(src), false, '不得用模板字符串渲染切换时间');
});

test('B3 静态守卫：creditBlock 与 accountDetail 的 foot 不再拼 switchAt', () => {
  const credit = codeOnly(functionSource('creditBlock'));
  const detail = codeOnly(functionSource('accountDetail'));
  assert.equal(credit.includes('switchAt'), false, 'creditBlock 不应再读 switchAt');
  assert.equal(credit.includes('credit-switch'), false, 'creditBlock 不应再产出 .credit-switch 节点');
  assert.equal(detail.includes('switchAt'), false, 'accountDetail 不应再读 switchAt');
  // 明细底部仍要保留 Token 状态与操作按钮（只删了 switchAt 一行，不能删漏或删多）
  assert.match(detail, /Token \$\{token\.text\}/, 'detail-foot 仍须展示 Token 状态');
  assert.match(detail, /detailAction\('刷新额度'/, 'detail-foot 仍须保留「刷新额度」');
  assert.match(detail, /detailAction\('测试签到'/, 'detail-foot 仍须保留「测试签到」');
  assert.match(detail, /detailAction\('导出'/, 'detail-foot 仍须保留「导出」');
});

test('B3 静态守卫：src/credits.js 的 switchAt 产出未被误删（后端契约不动）', () => {
  const credits = readText(CREDITS_PATH);
  assert.match(credits, /const switchAt = baseMember/, 'credits.js 仍须计算 switchAt');
  assert.match(credits, /^\s*switchAt,$/m, 'credits.js 的返回对象仍须带 switchAt');
  assert.match(credits, /switchAt:string\|null/, 'JSDoc 里的 switchAt 类型也不能删');
});

// ============ B1：布局的静态守卫 ============

/** 取出 701~900 媒体查询的整块 CSS。 */
function extractMidRangeMedia() {
  const matched = /@media \(min-width: 701px\) and \(max-width: 900px\) \{[\s\S]*?\n\}/.exec(readCss());
  assert.ok(matched, 'public/styles.css 必须存在 701~900 的媒体查询');
  return matched[0];
}

test('B1 静态守卫：701~900 媒体查询同时解掉包含块并浮起 .top-right', () => {
  const block = extractMidRangeMedia();
  assert.match(block, /\.shell \{ position: relative; \}/, '.shell 必须成为新的包含块');
  assert.match(block, /position: static;/, '.topbar 必须降为 static（否则仍是绝对定位包含块）');
  assert.match(block, /backdrop-filter: none;/, 'backdrop-filter 也会创建包含块，必须关掉');
  assert.match(block, /-webkit-backdrop-filter: none;/, 'Safari 前缀同样要关');
  // .top-right 必须是 absolute 且贴到 .shell 顶部
  const topRight = /\n  \.top-right \{[\s\S]*?\n  \}/.exec(block);
  assert.ok(topRight, '块内必须存在 .top-right 规则');
  assert.match(topRight[0], /position: absolute;/, '.top-right 必须 absolute');
  assert.match(topRight[0], /top: 0;/, '.top-right 必须贴顶（第一行）');
  assert.match(topRight[0], /right: 10px;/, '.top-right 必须贴右');
  assert.match(topRight[0], /z-index: 5;/, '图标必须浮在导航行之上且可点');
  // 侧栏要给图标留位置，否则导航项被压住
  const sidebar = /\n  \.sidebar \{[^}]*\}/.exec(block);
  assert.ok(sidebar, '块内必须存在 .sidebar 规则');
  assert.match(sidebar[0], /padding-right: 148px;/, '.sidebar 必须预留图标宽度');
});

test('B1 静态守卫：≥901px 仍是左侧栏 sticky 玻璃顶栏，≤700px 仍是底部 Tab Bar', () => {
  const css = readCss();
  // 全局规则（901px 以上生效）不得被改成 static
  assert.match(css, /^\.topbar \{\n  position: sticky;/m, '桌面端顶栏必须保持 sticky');
  assert.match(css, /^\.sidebar \{\n  position: sticky;/m, '桌面端侧栏必须保持 sticky');
  // 手机断点仍是 fixed 底部 Tab Bar
  assert.match(css, /\.sidebar \{\n    position: fixed;[\s\S]{0,200}?bottom: 0;/, '≤700px 侧栏仍是底部 fixed Tab Bar');
  // 701~900 的规则不得写进无媒体查询的全局作用域
  const globals = css.replace(/@media[\s\S]*$/m, '');
  assert.equal(/\.top-right \{[^}]*position: absolute/.test(globals), false, '绝对定位不得泄漏到全局');
});

test('B1 静态守卫：.credit-switch 的 CSS 规则已随字段一起删除', () => {
  assert.equal(readCss().includes('.credit-switch'), false, 'styles.css 里不应再有 .credit-switch 规则');
});
