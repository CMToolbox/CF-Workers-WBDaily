// public/app.js
// 零构建原生前端：单 state + 全量 render，无框架 / 无 CDN / 无内联事件。
// 安全约定：所有来自服务端或用户的文本一律走 textContent；
// innerHTML 只用于下面 ICONS 里的静态 SVG 常量（不含任何动态数据）。

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

/** 静态 SVG 图标（纯常量，绝不含用户输入）。 */
const ICONS = Object.freeze({
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l12 8-12 8z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 10-3.2 6.4"/><path d="M20 5v6h-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 20h16"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>',
});

/** Asia/Shanghai 时间格式（月/日 时:分）。 */
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 积分/额度数字格式（最多两位小数）。 */
const CREDIT_FMT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

/** 完整日期时间（年/月/日 时:分，Asia/Shanghai）。 */
const DATETIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 全局状态（唯一真相，驱动全量渲染）。 */
const state = {
  view: 'boot',
  accounts: [],
  logs: [],
  settings: null,
  mcpKey: null,
  opened: {},
  details: {},
  filters: { onlyFailed: false, q: '' },
  error: null,
  authError: null,
  credits: {},
  // export 按账号粒度记录忙碌态：all 表示「导出全部」，ids 表示正在导出的账号 id。
  // 单账号导出互不阻塞（A 账号导出中不影响 B 账号的导出按钮）。
  busy: {
    run: false,
    test: null,
    import: false,
    export: { all: false, ids: new Set() },
    save: false,
    key: false,
    pw: false,
    retention: false,
    setup: false,
    login: false,
  },
  loading: { accounts: false, logs: false },
  me: null,
  setupTokenRequired: false,
  version: '1.0.0',
};

/** 业务错误的统一载体。 */
class ApiError extends Error {
  constructor(code, message, status = 0, detail = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// ============ 小工具 ============

/**
 * 创建元素。
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * 生成图标元素（静态 SVG 常量）。
 * @param {'plus'|'play'|'refresh'|'edit'|'trash'} name
 * @returns {HTMLElement}
 */
function icon(name) {
  const span = el('span', 'icon');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || ''; // 静态常量，不含任何用户输入
  return span;
}

/**
 * 把静态 HTML 中的 data-icon 占位替换成 SVG。
 */
function hydrateStaticIcons() {
  for (const node of $$('[data-icon]')) {
    node.innerHTML = ICONS[node.dataset.icon] || ''; // 静态常量，不含任何用户输入
  }
}

/**
 * 重设按钮内容（图标 + 文案）。
 * @param {HTMLElement} button
 * @param {string|null} iconName
 * @param {string} label
 */
function setButtonContent(button, iconName, label) {
  button.textContent = '';
  if (iconName) button.appendChild(icon(iconName));
  button.appendChild(document.createTextNode(label));
}

/** @param {string} iso @returns {string} */
function fmtTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return TIME_FMT.format(date);
}

/** @param {string} iso @returns {string} */
function fmtRelative(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return '刚刚';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** @param {number} ms @returns {string} */
function fmtDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

/**
 * 结果 -> 徽标。
 * @param {string|null} result
 * @returns {HTMLElement}
 */
function resultBadge(result) {
  const map = {
    checked_in: ['签到成功', 'badge-ok'],
    already_checked_in: ['今日已签', 'badge-info'],
    failed: ['失败', 'badge-bad'],
    skipped_disabled: ['已跳过', 'badge-warn'],
    dry_run_ok: ['可签到', 'badge-info'],
  };
  const hit = map[result];
  if (!hit) return el('span', 'badge badge-mute', '未跑过');
  return el('span', `badge ${hit[1]}`, hit[0]);
}

/** @param {string} trigger @returns {HTMLElement} */
function triggerBadge(trigger) {
  const map = { cron: ['定时', 'badge-info'], manual: ['手动', 'badge-ok'], 'manual-single': ['单账号', 'badge-warn'] };
  const hit = map[trigger] || [String(trigger || '未知'), 'badge-mute'];
  return el('span', `badge ${hit[1]} badge-trigger`, hit[0]);
}

// ============ 视图与提示 ============

/**
 * 切换视图（setup / login / panel）。
 * @param {'setup'|'login'|'panel'|'boot'} name
 */
function showView(name) {
  state.view = name;
  const views = { setup: '#view-setup', login: '#view-login', panel: '#view-panel' };
  for (const [key, selector] of Object.entries(views)) {
    const node = $(selector);
    if (node) node.hidden = key !== name;
  }
  if (name === 'login') $('#login-password').focus();
  if (name === 'setup') $('#setup-password').focus();
}

/** @param {string} code @param {string} message */
function setError(code, message) {
  state.error = { code, message };
  renderError();
}

function clearError() {
  state.error = null;
  renderError();
}

/** @param {string} code @param {string} message */
function setAuthError(code, message) {
  state.authError = { code, message };
  renderAuthError();
}

function clearAuthError() {
  state.authError = null;
  renderAuthError();
}

/**
 * 显示 toast（同一文案去重，最多同时 3 条，始终固定在底部）。
 * @param {string} message
 * @param {'ok'|'bad'|'warn'|'info'} [kind]
 */
function toast(message, kind = 'info') {
  const host = $('#toast-host');
  const text = String(message);
  // 去重：相同文案不叠加（连点按钮不会堆出一列胶囊）
  for (const existing of Array.from(host.children)) {
    if (existing.dataset.message === text) {
      existing.remove();
    }
  }
  while (host.children.length >= 3) {
    host.firstElementChild.remove();
  }
  const node = el('div', `toast is-${kind}`, text);
  node.dataset.message = text;
  host.appendChild(node);
  window.setTimeout(() => node.remove(), 4200);
}

// ============ 渲染 ============

function renderAll() {
  renderError();
  renderAuthError();
  renderTop();
  renderAccounts();
  renderLogs();
  renderSettings();
  syncBusy();
}

function renderError() {
  const bar = $('#panel-error');
  const text = $('#panel-error-text');
  if (!state.error) {
    bar.hidden = true;
    text.textContent = '';
    return;
  }
  text.textContent = `${state.error.code}: ${state.error.message}`;
  bar.hidden = false;
}

function renderAuthError() {
  const setupError = $('#setup-error');
  const loginError = $('#login-error');
  if (state.view === 'setup') {
    setupError.hidden = !state.authError;
    setupError.textContent = state.authError ? state.authError.message : '';
  } else {
    setupError.hidden = true;
  }
  if (state.view === 'login') {
    loginError.hidden = !state.authError;
    loginError.textContent = state.authError ? state.authError.message : '';
  } else {
    loginError.hidden = true;
  }
}

function renderTop() {
  const node = $('#top-writes');
  const value = state.settings && Number.isFinite(state.settings.kvWritesToday) ? state.settings.kvWritesToday : 0;
  node.textContent = `≈ ${value}/1000`;
  node.classList.toggle('is-high', value > 800);
  node.title = value > 800
    ? '今日 KV 写入接近免费额度（1000/天），请减少手动签到次数'
    : '今日 KV 写入次数（近似值，免费额度 1000/天）';
}

/** @param {string} accountId @returns {string} */
function accountName(accountId) {
  const hit = state.accounts.find((account) => account.id === accountId);
  return hit ? hit.name : '';
}

/**
 * 找某账号最近一次结果（依赖 RunSummary.accountResults，零额外读）。
 * @param {string} accountId
 * @returns {string|null}
 */
function latestResultFor(accountId) {
  for (const run of state.logs) {
    const results = Array.isArray(run.accountResults) ? run.accountResults : [];
    const hit = results.find((item) => item && item.accountId === accountId);
    if (hit) return hit.result;
  }
  return null;
}

function renderAccounts() {
  const list = $('#accounts-list');
  const skeleton = $('#accounts-skeleton');
  const empty = $('#accounts-empty');
  list.textContent = '';
  $('#accounts-count').textContent = String(state.accounts.length);

  const loading = state.loading.accounts && state.accounts.length === 0;
  skeleton.hidden = !loading;
  empty.hidden = loading || state.accounts.length > 0;

  for (const account of state.accounts) {
    list.appendChild(accountCard(account));
  }
}

/**
 * 积分数字格式化。
 * @param {number|null|undefined} value
 * @returns {string}
 */
function fmtCredits(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return CREDIT_FMT.format(number);
}

/**
 * 完整日期时间格式化（Asia/Shanghai）。
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return DATETIME_FMT.format(date);
}

/**
 * 上海时区日期戳 YYYY-MM-DD（用于导出文件名）。
 * @param {Date} [date]
 * @returns {string}
 */
function fmtDateStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => (parts.find((item) => item.type === type)?.value || '');
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * 把账号名转成文件名安全片段：替换 Windows/macOS 非法字符与控制字符为 `_`，
 * 去掉首尾空白与点（Windows 不允许文件名以点结尾），保留中文。
 * 清理后为空则回退为账号 id。
 * @param {string} name 账号名
 * @param {string} fallback 兜底值（账号 id）
 * @returns {string}
 */
function sanitizeFilenamePart(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
    .slice(0, 64);
  const safeFallback = String(fallback || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_');
  return cleaned || safeFallback || 'account';
}

/**
 * 触发浏览器下载 JSON 文件。
 * @param {string} filename
 * @param {*} data
 */
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 账号卡片：基础信息 + 积分配额 + 操作。
 * @param {object} account
 * @returns {HTMLElement}
 */
function accountCard(account) {
  const card = el('article', 'acc-card');
  const entry = state.credits[account.id];
  const planLabel = entry && entry.data ? entry.data.planLabel : null;

  // ---- 卡片头：状态点 + 名称 + 套餐徽标 + 编辑/删除 ----
  const head = el('div', 'acc-card-head');
  const dot = el('span', `dot${account.enabled ? ' on' : ''}`);
  dot.title = account.enabled ? '已启用' : '已禁用';
  head.appendChild(dot);
  head.appendChild(el('strong', 'acc-card-name', account.name));
  if (planLabel) head.appendChild(el('span', 'plan-badge', planLabel));

  const tools = el('div', 'acc-card-tools');
  const testing = state.busy.test === account.id;

  const editBtn = el('button', 'btn btn-ghost btn-icon');
  editBtn.type = 'button';
  editBtn.title = '编辑';
  editBtn.setAttribute('aria-label', `编辑账号 ${account.name}`);
  editBtn.appendChild(icon('edit'));
  editBtn.disabled = testing;
  editBtn.addEventListener('click', () => openAccountDialog(account));

  const delBtn = el('button', 'btn btn-ghost btn-icon btn-danger-ghost');
  delBtn.type = 'button';
  delBtn.title = '删除';
  delBtn.setAttribute('aria-label', `删除账号 ${account.name}`);
  delBtn.appendChild(icon('trash'));
  delBtn.disabled = testing;
  delBtn.addEventListener('click', () => askDeleteAccount(account));

  tools.appendChild(editBtn);
  tools.appendChild(delBtn);
  head.appendChild(tools);
  card.appendChild(head);

  // ---- 凭据与最近签到结果 ----
  const meta = el('div', 'acc-meta');
  meta.appendChild(el('code', 'acc-token', account.tokenMasked));
  meta.appendChild(el('span', `acc-uid${account.uid ? '' : ' is-empty'}`, account.uid ? `UID ${account.uid}` : 'UID —'));
  meta.appendChild(resultBadge(latestResultFor(account.id)));
  card.appendChild(meta);

  // ---- 积分配额 ----
  card.appendChild(creditBlock(account, entry));

  // ---- 操作 ----
  const foot = el('div', 'acc-card-foot');
  // busy 态：文案不变 + 按钮内 spinner + disabled（不做绝对定位浮层，不替换文案）
  const testBtn = el('button', `btn btn-ghost btn-sm${testing ? ' is-busy' : ''}`, '测试签到');
  testBtn.type = 'button';
  testBtn.disabled = testing || state.busy.run;
  testBtn.setAttribute('aria-busy', testing ? 'true' : 'false');
  if (testing) testBtn.title = '签到中…';
  testBtn.addEventListener('click', () => testCheckin(account));

  const creditsLoading = Boolean(entry && entry.loading);
  const creditBtn = el('button', `btn btn-ghost btn-sm${creditsLoading ? ' is-busy' : ''}`, '刷新额度');
  creditBtn.type = 'button';
  creditBtn.disabled = creditsLoading;
  creditBtn.setAttribute('aria-busy', creditsLoading ? 'true' : 'false');
  creditBtn.title = '重新查询积分配额';
  creditBtn.addEventListener('click', () => loadCredits(account.id));

  // 单账号导出：卡片内直接导出「这个账号」的 cockpit-tools JSON（含明文 token）
  const exporting = isExporting(account.id);
  const exportBtn = el('button', `btn btn-ghost btn-sm${exporting ? ' is-busy' : ''}`, '导出');
  exportBtn.type = 'button';
  exportBtn.disabled = exporting;
  exportBtn.setAttribute('aria-busy', exporting ? 'true' : 'false');
  exportBtn.setAttribute('aria-label', `导出账号 ${account.name} 的 JSON`);
  exportBtn.title = exporting
    ? '导出中…'
    : `导出「${account.name}」的账号 JSON（文件含明文 token）`;
  exportBtn.addEventListener('click', () => askExportAccount(account));

  foot.appendChild(testBtn);
  foot.appendChild(creditBtn);
  foot.appendChild(exportBtn);
  card.appendChild(foot);

  return card;
}

/**
 * 积分配额区块（含加载 / 错误 / 空态）。
 * @param {object} account
 * @param {object|undefined} entry
 * @returns {HTMLElement}
 */
function creditBlock(account, entry) {
  const wrap = el('div', 'credit-block');

  if (!entry || (entry.loading && !entry.data)) {
    wrap.appendChild(el('div', 'credit-loading', '正在查询积分配额…'));
    const skeleton = el('div', 'credit-skeleton');
    skeleton.appendChild(el('div', 'skeleton-row'));
    skeleton.appendChild(el('div', 'skeleton-row'));
    wrap.appendChild(skeleton);
    return wrap;
  }

  if (entry.error) {
    const error = el('div', 'credit-error');
    error.appendChild(el('span', null, entry.error.tokenInvalid
      ? 'Token 已失效，请更新账号 token 后重试'
      : (entry.error.message || '额度查询失败')));
    const retry = el('button', 'btn btn-ghost btn-sm', '重试');
    retry.type = 'button';
    retry.addEventListener('click', () => loadCredits(account.id));
    error.appendChild(retry);
    wrap.appendChild(error);
    return wrap;
  }

  const data = entry.data;
  if (!data) {
    wrap.appendChild(el('div', 'credit-loading', '尚未查询积分配额'));
    return wrap;
  }

  const usage = el('div', 'usage-line');
  usage.appendChild(el('span', 'usage-label', '用量状态'));
  usage.appendChild(el('span', `usage-value ${data.status === 'normal' ? 'is-ok' : 'is-warn'}`,
    data.status === 'normal' ? '正常' : '异常'));
  wrap.appendChild(usage);

  const total = el('div', 'credit-total');
  total.appendChild(el('span', 'credit-total-label', '总剩余积分'));
  total.appendChild(el('strong', 'credit-total-value', fmtCredits(data.totalLeft)));
  wrap.appendChild(total);

  const groups = Array.isArray(data.groups) ? data.groups : [];
  if (groups.length === 0) {
    wrap.appendChild(el('p', 'credit-loading', '暂无有效积分包'));
  } else {
    for (const group of groups) wrap.appendChild(creditGroupRow(group));
  }

  if (data.switchAt) {
    wrap.appendChild(el('div', 'credit-switch', `切换时间：${fmtDateTime(data.switchAt)}`));
  }
  return wrap;
}

/**
 * 单类积分：名称 + 剩余 + 已使用/总量 + 剩余百分比 + 进度条。
 * @param {object} group
 * @returns {HTMLElement}
 */
function creditGroupRow(group) {
  const row = el('div', 'credit-group');

  const head = el('div', 'credit-group-head');
  head.appendChild(el('span', 'credit-group-label', group.label || '积分'));
  head.appendChild(el('span', 'credit-group-left', fmtCredits(group.left)));
  row.appendChild(head);

  const sub = el('div', 'credit-group-sub');
  sub.appendChild(el('span', null, `已使用 ${fmtCredits(group.used)}/${fmtCredits(group.total)}`));
  sub.appendChild(el('span', null, `剩余${Number.isFinite(Number(group.remainPercent)) ? group.remainPercent : 0}%`));
  row.appendChild(sub);

  const total = Number(group.total);
  const used = Number(group.used);
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;
  const track = el('div', 'credit-track');
  const bar = el('i');
  bar.style.width = `${percent}%`;
  track.appendChild(bar);
  row.appendChild(track);

  if (group.expiring) row.appendChild(el('span', 'credit-expiry', '即将过期'));
  return row;
}

/**
 * 日志筛选（纯内存过滤，零请求）。
 * @returns {object[]}
 */
function visibleLogs() {
  const q = state.filters.q.trim().toLowerCase();
  return state.logs.filter((run) => {
    if (state.filters.onlyFailed && !(Number(run.failed) > 0)) return false;
    if (!q) return true;
    if (String(run.runId || '').toLowerCase().includes(q)) return true;
    if (String(run.trigger || '').toLowerCase().includes(q)) return true;
    for (const item of Array.isArray(run.accountResults) ? run.accountResults : []) {
      if (item && accountName(item.accountId).toLowerCase().includes(q)) return true;
    }
    const detail = state.details[run.runId];
    if (detail && Array.isArray(detail.entries)) {
      for (const entry of detail.entries) {
        if (String(entry.accountName || '').toLowerCase().includes(q)) return true;
      }
    }
    return false;
  });
}

function renderLogs() {
  const list = $('#logs-list');
  const skeleton = $('#logs-skeleton');
  const empty = $('#logs-empty');
  list.textContent = '';

  const loading = state.loading.logs && state.logs.length === 0;
  skeleton.hidden = !loading;

  const rows = visibleLogs();
  if (loading) {
    empty.hidden = true;
    return;
  }
  if (state.logs.length === 0) {
    empty.hidden = false;
    empty.textContent = '还没有执行记录。Cron 每天 09:00（Asia/Shanghai）自动执行，也可以点「立即全部签到」。';
    return;
  }
  if (rows.length === 0) {
    empty.hidden = false;
    empty.textContent = '没有符合筛选条件的记录。';
    return;
  }
  empty.hidden = true;
  for (const run of rows) {
    list.appendChild(runItem(run));
  }
}

/**
 * @param {object} run RunSummary
 * @returns {HTMLElement}
 */
function runItem(run) {
  const wrap = el('div', `log-item${state.opened[run.runId] ? ' is-open' : ''}`);

  const head = el('button', 'log-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', state.opened[run.runId] ? 'true' : 'false');

  const time = el('div', 'log-time');
  time.appendChild(el('strong', null, fmtTime(run.startedAt)));
  time.appendChild(el('small', null, fmtRelative(run.startedAt)));

  const trigger = triggerBadge(run.trigger);

  const meta = el('div', 'log-meta');
  const total = Number(run.total) || 0;
  const success = Number(run.success) || 0;
  const failed = Number(run.failed) || 0;
  const skipped = Number(run.skipped) || 0;
  const writes = Number(run.kvWriteCount) || 0;
  // 单行紧凑摘要：成功 2/3 · 失败 1 · 269ms · 写入 4（失败为 0 时不出现「失败 0」）
  const summaryParts = [`成功 ${success}/${total}`];
  if (failed > 0) summaryParts.push(`失败 ${failed}`);
  if (skipped > 0) summaryParts.push(`跳过 ${skipped}`);
  summaryParts.push(fmtDuration(run.durationMs));
  summaryParts.push(`写入 ${writes}`);
  if (run.truncated) summaryParts.push('已截断');
  meta.textContent = summaryParts.join(' · ');
  if (failed > 0) meta.classList.add('is-bad');

  const chevron = el('span', 'log-chevron', '▶');

  head.appendChild(time);
  head.appendChild(trigger);
  head.appendChild(meta);
  head.appendChild(chevron);
  head.addEventListener('click', () => toggleRun(run.runId));

  wrap.appendChild(head);

  if (state.opened[run.runId]) {
    const body = el('div', 'log-body');
    const detail = state.details[run.runId];
    if (!detail) {
      body.appendChild(el('p', 'muted', '加载中…'));
    } else if (detail.error) {
      body.appendChild(el('p', 'form-error', detail.error));
    } else {
      const entries = Array.isArray(detail.entries) ? detail.entries : [];
      if (entries.length === 0) {
        body.appendChild(el('p', 'muted', '这次执行没有任何账号记录。'));
      }
      for (const entry of entries) {
        body.appendChild(entryRow(entry));
      }
    }
    wrap.appendChild(body);
  }

  return wrap;
}

/**
 * @param {object} entry LogEntry
 * @returns {HTMLElement}
 */
function entryRow(entry) {
  const row = el('div', 'entry');
  row.appendChild(el('div', 'entry-name', entry.accountName || entry.accountId || '未知账号'));
  row.appendChild(resultBadge(entry.result));
  row.appendChild(el('div', 'entry-msg', entry.message || '—'));

  const sub = el('div', 'entry-sub');
  sub.appendChild(el('span', null, `HTTP ${entry.httpStatus === null || entry.httpStatus === undefined ? '—' : entry.httpStatus}`));
  sub.appendChild(el('span', null, `code ${entry.code === null || entry.code === undefined ? '—' : entry.code}`));
  if (entry.streakDays !== null && entry.streakDays !== undefined) sub.appendChild(el('span', null, `连续 ${entry.streakDays} 天`));
  if (entry.credit !== null && entry.credit !== undefined) sub.appendChild(el('span', null, `+${entry.credit} 额度`));
  sub.appendChild(el('span', null, fmtDuration(entry.durationMs)));
  if (entry.tokenInvalid) sub.appendChild(el('span', 'badge badge-bad', 'token 失效'));
  row.appendChild(sub);
  return row;
}

function renderSettings() {
  const settings = state.settings;
  if (settings) {
    $('#retention-input').value = String(settings.retentionRuns);
    $('#cron-local').textContent = settings.cronLocal || '09:00';
    $('#cron-utc').textContent = settings.cronUtc || '0 1 * * *';
  }
  $('#settings-version').textContent = state.version || '1.0.0';

  const prefixNode = $('#mcp-prefix');
  if (state.mcpKey && state.mcpKey.exists) {
    prefixNode.textContent = `当前 Key：${state.mcpKey.prefix || '（未知前缀）'}`;
    setButtonContent($('#btn-gen-mcp'), null, '重置 Key');
  } else {
    prefixNode.textContent = '未生成';
    setButtonContent($('#btn-gen-mcp'), null, '生成 Key');
  }
}

/** 同步所有按钮的 busy 状态（spinner 在按钮内，文案不变）。 */
function syncBusy() {
  const runBtn = $('#btn-run-all');
  runBtn.disabled = state.busy.run;
  runBtn.classList.toggle('is-busy', state.busy.run);
  runBtn.setAttribute('aria-busy', state.busy.run ? 'true' : 'false');
  setButtonContent(runBtn, 'play', '立即全部签到');

  $('#btn-refresh').disabled = state.busy.run;
  $('#btn-add-account').disabled = state.busy.run;
  $('#btn-save-retention').disabled = state.busy.retention;
  $('#btn-gen-mcp').disabled = state.busy.key;
  $('#btn-change-pw').disabled = state.busy.pw;
  $('#btn-setup').disabled = state.busy.setup;
  $('#btn-login').disabled = state.busy.login;
  $('#btn-clear-logs').disabled = state.busy.run;

  // 「导出全部」忙碌态：单账号导出不影响这里，反之亦然
  const exportAllBtn = $('#btn-export-accounts');
  if (exportAllBtn) {
    exportAllBtn.disabled = state.busy.export.all;
    exportAllBtn.classList.toggle('is-busy', state.busy.export.all);
    exportAllBtn.setAttribute('aria-busy', state.busy.export.all ? 'true' : 'false');
  }
}

// ============ 网络层 ============

/**
 * 统一 API 客户端。
 * @param {string} path
 * @param {{method?:string, body?:*, headers?:Record<string,string>, allow401?:boolean}} [options]
 * @returns {Promise<*>} 信封里的 data
 */
async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { ...(options.headers || {}) },
  };
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('NETWORK', '网络错误，请检查连接后重试', 0);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 401 && !options.allow401) {
    stopPolling();
    state.me = null;
    showView('login');
    const message = payload && payload.error && payload.error.message ? payload.error.message : '登录已失效，请重新登录';
    setAuthError('UNAUTHORIZED', message);
    throw new ApiError('UNAUTHORIZED', message, 401);
  }

  if (!payload || typeof payload !== 'object') {
    throw new ApiError('BAD_RESPONSE', `服务返回异常（HTTP ${response.status}）`, response.status);
  }
  if (payload.ok === false) {
    const error = payload.error || {};
    throw new ApiError(error.code || 'INTERNAL', error.message || '请求失败', response.status, payload.detail || null);
  }
  return payload.data;
}

// ============ 数据加载 ============

/** 启动流程：bootstrap -> session 探活 -> setup / login / panel。 */
async function boot() {
  clearAuthError();
  try {
    const data = await api('/api/bootstrap', { allow401: true });
    state.setupTokenRequired = Boolean(data && data.setupTokenRequired);
    state.version = (data && data.version) || '1.0.0';
    $('#setup-token-wrap').hidden = !state.setupTokenRequired;

    if (!data || !data.initialized) {
      showView('setup');
      renderAuthError();
      return;
    }
    try {
      const me = await api('/api/session', { allow401: true });
      state.me = me;
      await enterPanel();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        showView('login');
        renderAuthError();
        return;
      }
      throw err;
    }
  } catch (err) {
    // bootstrap 本身失败：留在登录页给一个重试入口
    showView('login');
    $('#btn-retry').hidden = false;
    setAuthError(err.code || 'NETWORK', err.message || '无法连接服务');
  }
}

/** 进入面板：切视图 + 开轮询 + 首屏并发 4 个 GET。 */
async function enterPanel() {
  showView('panel');
  state.authError = null;
  renderAuthError();
  startPolling();
  await loadPanel();
}

/** 首屏 4 个 GET 并发；任一失败只显示错误条，不清空其他区块。 */
async function loadPanel() {
  state.loading.accounts = true;
  state.loading.logs = true;
  renderAccounts();
  renderLogs();

  const results = await Promise.allSettled([
    api('/api/accounts').then((data) => { state.accounts = Array.isArray(data) ? data : []; }),
    api('/api/logs').then((data) => { state.logs = Array.isArray(data) ? data : []; }),
    api('/api/settings').then((data) => { state.settings = data || null; }),
    api('/api/mcp-key').then((data) => { state.mcpKey = data || { exists: false }; }),
  ]);

  state.loading.accounts = false;
  state.loading.logs = false;

  const failure = results.find((item) => item.status === 'rejected');
  if (failure) {
    const err = failure.reason;
    if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '加载失败');
    }
  } else {
    clearError();
  }
  renderAll();
  // 首屏先渲染账号与日志，再后台补积分（每账号 3 个上游请求，不阻塞首屏）
  void loadAllCredits({ onlyMissing: true, silent: true });
}

/** 轮询只刷日志与设置（零额外读）。 */
async function refreshQuiet() {
  if (state.view !== 'panel') return;
  const results = await Promise.allSettled([
    api('/api/logs').then((data) => { state.logs = Array.isArray(data) ? data : []; }),
    api('/api/settings').then((data) => { state.settings = data || null; }),
  ]);
  const failure = results.find((item) => item.status === 'rejected');
  if (failure && !(failure.reason instanceof ApiError && failure.reason.status === 401)) {
    setError(failure.reason.code || 'INTERNAL', failure.reason.message || '刷新失败');
    return;
  }
  if (!failure) clearError();
  renderTop();
  renderLogs();
  renderSettings();
  renderAccounts();
}

let pollTimer = null;

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (state.view !== 'panel') return;
    refreshQuiet();
  }, 30000);
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 只刷新账号（增删改后）。 */
async function refreshAccounts() {
  try {
    const data = await api('/api/accounts');
    state.accounts = Array.isArray(data) ? data : [];
    renderAccounts();
    void loadAllCredits({ onlyMissing: true, silent: true });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message);
  }
}

/**
 * 查询单个账号的积分配额（只读上游，零 KV 写）。
 * @param {string} accountId
 * @param {{silent?:boolean, render?:boolean}} [options]
 * @returns {Promise<void>}
 */
async function loadCredits(accountId, options = {}) {
  const id = String(accountId || '');
  if (!id) return;
  const current = state.credits[id];
  if (current && current.loading) return;
  const render = options.render !== false;
  state.credits[id] = { loading: true, data: current ? current.data : null, error: null };
  if (render) renderAccounts();

  try {
    const data = await api(`/api/accounts/${encodeURIComponent(id)}/credits`);
    state.credits[id] = { loading: false, data: data || null, error: null };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // 401 表示面板会话失效，api() 已统一回登录页，这里不再渲染错误
      state.credits[id] = { loading: false, data: null, error: null };
      return;
    }
    state.credits[id] = {
      loading: false,
      data: null,
      error: {
        code: (err && err.code) || 'INTERNAL',
        message: (err && err.message) || '额度查询失败',
        tokenInvalid: Boolean(err && err.detail && err.detail.tokenInvalid),
      },
    };
    if (!options.silent) toast(`额度查询失败：${(err && err.message) || '未知错误'}`, 'bad');
  } finally {
    if (render) renderAccounts();
  }
}

/**
 * 批量查询积分配额（首屏 / 手动刷新 / 新增账号后）。
 * @param {{onlyMissing?:boolean, silent?:boolean}} [options]
 * @returns {Promise<void>}
 */
async function loadAllCredits(options = {}) {
  const targets = state.accounts.filter((account) => {
    if (!account || !account.id) return false;
    if (!options.onlyMissing) return true;
    const entry = state.credits[account.id];
    return !entry || (!entry.loading && !entry.data && !entry.error);
  });
  if (targets.length === 0) return;
  await Promise.allSettled(targets.map((account) =>
    loadCredits(account.id, { silent: options.silent !== false, render: false })));
  renderAccounts();
}

/** 只刷新日志与设置（执行签到后）。 */
async function refreshLogs() {
  try {
    const [logs, settings] = await Promise.all([api('/api/logs'), api('/api/settings')]);
    state.logs = Array.isArray(logs) ? logs : [];
    state.settings = settings || null;
    renderLogs();
    renderSettings();
    renderTop();
    renderAccounts();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message);
  }
}

// ============ 动作 ============

async function submitSetup() {
  const password = $('#setup-password').value;
  const confirm = $('#setup-confirm').value;
  const setupToken = $('#setup-token').value.trim();
  // 与后端同口径：长度校验用 trim 后的值（后端也 trim），但提交原值
  const passwordValue = password.trim();
  const confirmValue = confirm.trim();
  clearAuthError();

  if (passwordValue.length < 8) {
    setAuthError('BAD_REQUEST', '密码至少 8 位');
    return;
  }
  if (passwordValue.length > 128) {
    setAuthError('BAD_REQUEST', '密码不能超过 128 位');
    return;
  }
  if (passwordValue !== confirmValue) {
    setAuthError('BAD_REQUEST', '两次输入的密码不一致');
    return;
  }
  if (state.setupTokenRequired && !setupToken) {
    setAuthError('FORBIDDEN', '请输入部署令牌（SETUP_TOKEN）');
    return;
  }

  state.busy.setup = true;
  syncBusy();
  try {
    const headers = setupToken ? { 'x-setup-token': setupToken } : {};
    await api('/api/setup', { method: 'POST', body: { password }, headers, allow401: true });
    toast('密码已设置，正在登录…', 'ok');
    await loginWith(password);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) setAuthError(err.code || 'INTERNAL', err.message || '设置失败');
  } finally {
    state.busy.setup = false;
    syncBusy();
  }
}

/**
 * 用已知密码登录（setup 成功后自动调用）。
 * @param {string} password
 */
async function loginWith(password) {
  const data = await api('/api/login', { method: 'POST', body: { password }, allow401: true });
  state.me = { authenticated: true, expiresAt: data.expiresAt };
  $('#setup-password').value = '';
  $('#setup-confirm').value = '';
  $('#login-password').value = '';
  await enterPanel();
}

async function submitLogin() {
  const password = $('#login-password').value;
  clearAuthError();
  if (!password) {
    setAuthError('BAD_REQUEST', '请输入密码');
    return;
  }
  state.busy.login = true;
  syncBusy();
  try {
    await loginWith(password);
    toast('登录成功', 'ok');
  } catch (err) {
    setAuthError(err.code || 'INTERNAL', err.message || '登录失败');
  } finally {
    state.busy.login = false;
    syncBusy();
  }
}

async function doLogout() {
  try {
    await api('/api/logout', { method: 'POST', allow401: true });
  } catch {
    /* 登出失败也照样清本地状态 */
  }
  stopPolling();
  state.me = null;
  state.accounts = [];
  state.logs = [];
  state.settings = null;
  state.mcpKey = null;
  state.credits = {};
  state.details = {};
  state.opened = {};
  clearError();
  clearAuthError();
  showView('login');
  toast('已登出', 'info');
}

async function runAll() {
  if (state.busy.run) return;
  state.busy.run = true;
  syncBusy();
  renderAccounts();
  try {
    const data = await api('/api/checkin/run', { method: 'POST', body: {} });
    const summary = data && data.summary ? data.summary : null;
    if (summary) {
      const kind = Number(summary.failed) > 0 ? 'warn' : 'ok';
      toast(`已完成：成功 ${summary.success} / 共 ${summary.total}${summary.failed ? `（失败 ${summary.failed}）` : ''}`, kind);
    } else {
      toast('已完成', 'ok');
    }
    if (data && data.flushError) setError('INTERNAL', data.flushError.message || '日志写入失败');
    await refreshLogs();
    // 整轮签到会改变多个账号的额度，统一重查（只读上游）
    void loadAllCredits({ silent: true });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'CONFLICT') {
      toast('已有任务在执行，请稍后再试', 'warn');
      setError('CONFLICT', err.message);
    } else if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '签到失败');
      toast('签到失败：' + (err.message || '未知错误'), 'bad');
    }
  } finally {
    state.busy.run = false;
    syncBusy();
    renderAccounts();
  }
}

/**
 * @param {object} account
 */
async function testCheckin(account) {
  if (state.busy.test) return;
  state.busy.test = account.id;
  renderAccounts();
  try {
    const data = await api(`/api/accounts/${encodeURIComponent(account.id)}/checkin`, { method: 'POST', body: {} });
    const result = data && data.result ? data.result : 'failed';
    if (result === 'checked_in') toast(`${account.name}：签到成功`, 'ok');
    else if (result === 'already_checked_in') toast(`${account.name}：今日已签到`, 'info');
    else toast(`${account.name}：${data && data.message ? data.message : '签到失败'}`, Number(data && data.tokenInvalid) ? 'bad' : 'warn');
    await refreshLogs();
    // 签到会消耗额度，顺带刷新该账号积分
    void loadCredits(account.id, { silent: true });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UPSTREAM_ERROR') {
      toast('上游不可用，请稍后再试', 'bad');
      setError('UPSTREAM_ERROR', err.message);
    } else if (err instanceof ApiError && err.code === 'CONFLICT') {
      toast('已有任务在执行', 'warn');
    } else if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '签到失败');
      toast('签到失败：' + (err.message || '未知错误'), 'bad');
    }
  } finally {
    state.busy.test = null;
    renderAccounts();
  }
}

let editingAccountId = null;

/**
 * 打开账号弹窗。
 * @param {object|null} account null 表示新增
 */
function openAccountDialog(account) {
  editingAccountId = account ? account.id : null;
  $('#dlg-account-title').textContent = account ? '编辑账号' : '新增账号';
  $('#acc-name').value = account ? account.name : '';
  $('#acc-token').value = '';
  $('#acc-token').placeholder = account ? `留空则不修改（当前 ${account.tokenMasked}）` : '粘贴 WorkBuddy token';
  $('#acc-uid').value = account ? account.uid || '' : '';
  $('#acc-remark').value = account ? account.remark || '' : '';
  $('#acc-enabled').checked = account ? account.enabled === true : true;
  setFormError('#dlg-account-error', '');
  $('#dlg-account').showModal();
}

/**
 * @param {string} selector
 * @param {string} message
 */
function setFormError(selector, message) {
  const node = $(selector);
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

async function saveAccount() {
  const name = $('#acc-name').value.trim();
  const token = $('#acc-token').value.trim();
  setFormError('#dlg-account-error', '');
  if (!name) {
    setFormError('#dlg-account-error', '请输入账号名称');
    return;
  }
  if (name.length > 32) {
    setFormError('#dlg-account-error', '账号名称不能超过 32 个字符');
    return;
  }
  const body = {
    name,
    uid: $('#acc-uid').value.trim(),
    remark: $('#acc-remark').value.trim(),
    enabled: $('#acc-enabled').checked,
  };
  if (editingAccountId === null) {
    if (!token) {
      setFormError('#dlg-account-error', '请输入 token');
      return;
    }
    body.token = token;
  } else if (token) {
    // 留空 = 不修改：请求体里不带 token 字段
    body.token = token;
  }

  const isCreate = editingAccountId === null;
  $('#btn-acc-save').disabled = true;
  try {
    if (isCreate) {
      await api('/api/accounts', { method: 'POST', body });
    } else {
      await api(`/api/accounts/${encodeURIComponent(editingAccountId)}`, { method: 'PUT', body });
    }
    $('#dlg-account').close();
    toast(isCreate ? '账号已添加' : '账号已更新', 'ok');
    await refreshAccounts();
    if (!isCreate && editingAccountId) {
      // token / uid 可能变化，强制重查该账号额度
      await loadCredits(editingAccountId, { silent: true });
    }
  } catch (err) {
    setFormError('#dlg-account-error', `${err.code || 'INTERNAL'}: ${err.message || '保存失败'}`);
  } finally {
    $('#btn-acc-save').disabled = false;
  }
}

/**
 * @param {object} account
 */
function askDeleteAccount(account) {
  askConfirm(
    {
      title: '删除账号',
      text: `确定删除「${account.name}」吗？该操作不可撤销（不会删除历史日志）。`,
      okLabel: '删除',
    },
    async () => {
      try {
        await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
        toast('账号已删除', 'ok');
        delete state.credits[account.id];
        await refreshAccounts();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message || '删除失败');
      }
    },
  );
}

/**
 * 上传前裁掉 cockpit-tools 的大字段（quota_raw/usage_raw 等），只保留导入所需字段。
 * 既减少请求体积，也避免把整份账号快照送到服务端。
 * @param {*} payload
 * @returns {*}
 */
function compactImportPayload(payload) {
  const pick = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return {
      access_token: item.access_token ?? item.accessToken ?? item.token,
      uid: item.uid,
      nickname: item.nickname,
      email: item.email,
    };
  };
  if (Array.isArray(payload)) return payload.map(pick);
  if (payload && Array.isArray(payload.accounts)) return { accounts: payload.accounts.map(pick) };
  if (payload && Array.isArray(payload.items)) return { items: payload.items.map(pick) };
  return pick(payload);
}

/**
 * 选择并导入 cockpit-tools 兼容的账号 JSON。
 * @param {Event} event
 */
async function onImportFile(event) {
  const input = event.target;
  const file = input && input.files && input.files[0];
  if (input) input.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toast('文件过大（上限 8MB）', 'bad');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast('不是合法的 JSON 文件', 'bad');
    return;
  }

  state.busy.import = true;
  renderAccounts();
  try {
    const data = await api('/api/accounts/import', { method: 'POST', body: compactImportPayload(payload) });
    const parts = [];
    if (Number(data.imported) > 0) parts.push(`新增 ${data.imported}`);
    if (Number(data.updated) > 0) parts.push(`更新 ${data.updated}`);
    if (Number(data.unchanged) > 0) parts.push(`未变化 ${data.unchanged}`);
    if (Number(data.skipped) > 0) parts.push(`跳过 ${data.skipped}`);
    const changed = Number(data.imported) > 0 || Number(data.updated) > 0;
    toast(parts.length ? `导入完成：${parts.join('，')}` : '没有可导入的账号', changed ? 'ok' : 'warn');
    if (Array.isArray(data.reasons) && data.reasons.length > 0) {
      setError('BAD_REQUEST', data.reasons.join('；'));
    }
    await refreshAccounts();
    void loadAllCredits({ silent: true });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '导入失败');
      toast(`导入失败：${err.message || '未知错误'}`, 'bad');
    }
  } finally {
    state.busy.import = false;
    renderAccounts();
  }
}

/**
 * 某账号是否正在导出（按账号粒度，互不阻塞）。
 * @param {string} accountId
 * @returns {boolean}
 */
function isExporting(accountId) {
  return state.busy.export.ids.has(String(accountId || ''));
}

/**
 * 单账号导出前确认（文件含明文 token，弹窗文案必须带上账号名，
 * 让用户清楚知道导出的是哪个账号）。
 * @param {object} account
 */
function askExportAccount(account) {
  if (!account || !account.id || isExporting(account.id)) return;
  const name = account.name || account.id;
  askConfirm(
    {
      title: '导出账号 JSON',
      text: `将导出「${name}」的账号 JSON，文件包含 token 明文，可用于在 cockpit-tools 中恢复该账号。请妥善保管，不要上传到公开位置。`,
      okLabel: '导出',
    },
    () => doExportAccount(account),
  );
}

/**
 * 导出单个账号：GET /api/accounts/export?id=
 * 失败（账号已被删除等）必须 toast，不能静默。
 * @param {object} account
 */
async function doExportAccount(account) {
  const id = account && account.id ? String(account.id) : '';
  if (!id || isExporting(id)) return;
  state.busy.export.ids.add(id);
  renderAccounts();
  try {
    const data = await api(`/api/accounts/export?id=${encodeURIComponent(id)}`);
    const list = Array.isArray(data) ? data : [];
    if (list.length === 0) {
      // 后端保证命中账号时返回长度 1 的数组；为空说明该账号没有可导出的 token
      const message = `账号「${account.name || id}」没有可导出的 token`;
      setError('BAD_REQUEST', message);
      toast(`导出失败：${message}`, 'bad');
      return;
    }
    const part = sanitizeFilenamePart(account.name, id);
    downloadJson(`workbuddy_account_${part}_${fmtDateStamp()}.json`, list);
    toast(`已导出「${account.name || id}」，注意文件含明文 token`, 'warn');
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '导出失败');
      toast(`导出失败：${err.message || '未知错误'}`, 'bad');
    }
  } finally {
    state.busy.export.ids.delete(id);
    renderAccounts();
  }
}

/** 导出全部账号前确认（文件含明文 token）。 */
function askExportAccounts() {
  if (state.busy.export.all) return;
  askConfirm(
    {
      title: '导出全部账号 JSON',
      text: '将导出全部账号的 JSON，文件包含 token 明文，可用于在 cockpit-tools 中批量恢复。请妥善保管，不要上传到公开位置。',
      okLabel: '导出全部',
    },
    doExportAccounts,
  );
}

async function doExportAccounts() {
  if (state.busy.export.all) return;
  state.busy.export.all = true;
  syncBusy();
  try {
    const data = await api('/api/accounts/export');
    downloadJson(`workbuddy_accounts_${fmtDateStamp()}.json`, data);
    toast('已导出全部账号，注意文件含明文 token', 'warn');
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '导出失败');
      toast(`导出失败：${err.message || '未知错误'}`, 'bad');
    }
  } finally {
    state.busy.export.all = false;
    syncBusy();
  }
}

/**
 * 展开/收起日志并懒加载明细。
 * @param {string} runId
 */
async function toggleRun(runId) {
  state.opened[runId] = !state.opened[runId];
  renderLogs();
  if (!state.opened[runId]) return;
  if (state.details[runId]) return;
  try {
    const detail = await api(`/api/logs/${encodeURIComponent(runId)}`);
    state.details[runId] = detail && typeof detail === 'object' ? detail : { error: '明细格式异常' };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    state.details[runId] = { error: `${err.code || 'INTERNAL'}: ${err.message || '加载失败'}` };
  }
  renderLogs();
}

function askClearLogs() {
  askConfirm(
    {
      title: '清空日志',
      text: '将删除全部执行记录（含明细），此操作不可撤销。账号与设置不受影响。',
      okLabel: '清空',
    },
    async () => {
      try {
        const data = await api('/api/logs', { method: 'DELETE' });
        state.logs = [];
        state.details = {};
        state.opened = {};
        toast(`已清空 ${data && Number.isFinite(data.deleted) ? data.deleted : 0} 条记录`, 'ok');
        await refreshLogs();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message || '清空失败');
      }
    },
  );
}

async function saveRetention() {
  const raw = Number($('#retention-input').value);
  const hint = $('#retention-hint');
  hint.hidden = true;
  if (!Number.isInteger(raw) || raw < 5 || raw > 100) {
    setError('BAD_REQUEST', '日志保留条数需为 5~100 的整数');
    return;
  }
  state.busy.retention = true;
  syncBusy();
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: { retentionRuns: raw } });
    renderTop();
    renderSettings();
    hint.hidden = false;
    const evicted = Number(state.settings && state.settings.evicted) || 0;
    toast(evicted > 0 ? `设置已保存，同时清理了 ${evicted} 条旧记录` : '设置已保存', 'ok');
    if (evicted > 0) await refreshLogs();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message || '保存失败');
  } finally {
    state.busy.retention = false;
    syncBusy();
  }
}

/**
 * 生成/重置 MCP Key。
 * @param {boolean} rotate 是否需要二次确认（重置）
 */
function requestMcpKey(rotate) {
  const run = async () => {
    state.busy.key = true;
    syncBusy();
    try {
      const data = await api('/api/mcp-key', { method: 'POST', body: {} });
      state.mcpKey = { exists: true, prefix: data.prefix };
      renderSettings();
      showMcpKey(data.key);
      toast('Key 已生成，请立即复制', 'ok');
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message || '生成失败');
    } finally {
      state.busy.key = false;
      syncBusy();
    }
  };
  if (!rotate) {
    run();
    return;
  }
  askConfirm(
    {
      title: '重置 MCP Key',
      text: '重置后旧的 Key 立即失效，所有已配置的 AI 客户端都需要更新。',
      okLabel: '重置',
    },
    run,
  );
}

/**
 * 展示 MCP Key 明文（只显示一次）。
 * @param {string} key
 */
function showMcpKey(key) {
  const input = $('#mcp-key-input');
  input.value = key;
  $('#dlg-mcp').showModal();
  input.focus();
  input.select();
}

async function copyMcpKey() {
  const input = $('#mcp-key-input');
  const key = input.value;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(key);
      toast('已复制到剪贴板', 'ok');
      return;
    }
    throw new Error('clipboard unavailable');
  } catch {
    input.focus();
    input.select();
    toast('自动复制不可用，请按 Ctrl/Cmd + C 手动复制', 'warn');
  }
}

async function changePassword() {
  const oldPassword = $('#pw-old').value;
  const newPassword = $('#pw-new').value;
  const confirm = $('#pw-confirm').value;
  // 与后端同口径：一律按 trim 后比较（旧密码也 trim，避免「带空格设的密码」永远改不了）
  const oldValue = oldPassword.trim();
  const newValue = newPassword.trim();
  const confirmValue = confirm.trim();
  setFormError('#pw-error', '');
  if (!oldValue) {
    setFormError('#pw-error', '请输入当前密码');
    return;
  }
  if (newValue.length < 8) {
    setFormError('#pw-error', '新密码至少 8 位');
    return;
  }
  if (newValue !== confirmValue) {
    setFormError('#pw-error', '两次输入的新密码不一致');
    return;
  }
  state.busy.pw = true;
  syncBusy();
  try {
    await api('/api/password', { method: 'POST', body: { oldPassword, newPassword } });
    $('#pw-old').value = '';
    $('#pw-new').value = '';
    $('#pw-confirm').value = '';
    stopPolling();
    state.me = null;
    showView('login');
    toast('密码已更新，请重新登录', 'ok');
  } catch (err) {
    setFormError('#pw-error', err.message || '修改失败');
  } finally {
    state.busy.pw = false;
    syncBusy();
  }
}

let confirmHandler = null;

/**
 * 通用二次确认。
 * @param {{title:string, text:string, okLabel?:string}} options
 * @param {Function} onConfirm
 */
function askConfirm(options, onConfirm) {
  $('#confirm-title').textContent = options.title;
  $('#confirm-text').textContent = options.text;
  $('#btn-confirm-ok').textContent = options.okLabel || '确认';
  confirmHandler = onConfirm;
  $('#dlg-confirm').showModal();
}

// ============ 事件绑定 ============

function bindEvents() {
  $('#btn-setup').addEventListener('click', submitSetup);
  $('#btn-login').addEventListener('click', submitLogin);
  $('#btn-retry').addEventListener('click', () => {
    $('#btn-retry').hidden = true;
    boot();
  });
  $('#form-setup').addEventListener('submit', (event) => {
    event.preventDefault();
    submitSetup();
  });
  $('#form-login').addEventListener('submit', (event) => {
    event.preventDefault();
    submitLogin();
  });

  $('#btn-logout').addEventListener('click', doLogout);
  $('#btn-refresh').addEventListener('click', async () => {
    await loadPanel();
    await loadAllCredits({ silent: true });
    toast('已刷新', 'info');
  });
  $('#btn-run-all').addEventListener('click', runAll);
  $('#btn-add-account').addEventListener('click', () => openAccountDialog(null));
  $('#btn-import-accounts').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', onImportFile);
  $('#btn-export-accounts').addEventListener('click', askExportAccounts);
  $('#btn-clear-logs').addEventListener('click', askClearLogs);
  $('#btn-save-retention').addEventListener('click', saveRetention);
  $('#btn-gen-mcp').addEventListener('click', () => requestMcpKey(Boolean(state.mcpKey && state.mcpKey.exists)));
  $('#btn-change-pw').addEventListener('click', changePassword);
  $('#btn-copy-key').addEventListener('click', copyMcpKey);
  $('#btn-panel-error-close').addEventListener('click', clearError);

  $('#filter-all').addEventListener('click', () => setFilter(false));
  $('#filter-failed').addEventListener('click', () => setFilter(true));
  $('#log-search').addEventListener('input', (event) => {
    state.filters.q = event.target.value;
    renderLogs();
  });

  $('#btn-acc-save').addEventListener('click', saveAccount);
  $('#btn-acc-cancel').addEventListener('click', () => $('#dlg-account').close());
  $('#btn-confirm-ok').addEventListener('click', async () => {
    const handler = confirmHandler;
    confirmHandler = null;
    $('#dlg-confirm').close();
    if (typeof handler === 'function') await handler();
  });
  $('#btn-confirm-cancel').addEventListener('click', () => {
    confirmHandler = null;
    $('#dlg-confirm').close();
  });
  $('#btn-mcp-close').addEventListener('click', () => {
    $('#mcp-key-input').value = '';
    $('#dlg-mcp').close();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.view === 'panel') refreshQuiet();
  });
}

/**
 * @param {boolean} onlyFailed
 */
function setFilter(onlyFailed) {
  state.filters.onlyFailed = onlyFailed;
  $('#filter-all').classList.toggle('is-active', !onlyFailed);
  $('#filter-failed').classList.toggle('is-active', onlyFailed);
  renderLogs();
}

// ============ 启动 ============

hydrateStaticIcons();
bindEvents();
renderAll();
boot();
