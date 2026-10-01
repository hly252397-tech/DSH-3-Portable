// dsh-earthquake-alert · 宿主半侧
//
// 职责：
//   1. 轮询上游地震数据源，做形状校验与去重，只把可信字段放进内存快照；
//   2. 通过只读 HTTP 端点提供快照，另经鉴权专属端点原子保存本插件偏好。
//
// 为什么不在客户端直连上游：页面可能带 CSP，且 N 个标签页会各轮询一份。
// 宿主侧只跑一份定时器，客户端读同源端点，两点都更稳。
//
// 数据来源是**第三方转发**的中国地震预警网（CENC）数据，不是官方授权通道。
// 本插件不产生任何预警结论，只做转发、几何距离与走时估算。
import Schema from 'schemastery';
import { createPreferencesStore, MAX_PREFERENCES_BYTES, preferenceError } from './preferences.js';

export const name = 'dsh-earthquake-alert';

export const Config = Schema.object({
  eewUrl: Schema.string().default('https://api.wolfx.jp/cenc_eew.json')
    .description('秒级预警（EEW）数据源。默认是第三方转发的中国地震预警网数据。'),
  listUrl: Schema.string().default('https://api.wolfx.jp/cenc_eqlist.json')
    .description('地震速报目录数据源，用于「最近地震」列表。'),
  pollSeconds: Schema.number().min(3).max(300).default(5)
    .description('预警轮询间隔（秒）。越短越及时，同时对上游访问越频繁。'),
  listSeconds: Schema.number().min(15).max(3600).default(60)
    .description('速报目录刷新间隔（秒）。'),
  timeoutSeconds: Schema.number().min(3).max(60).default(12)
    .description('单次上游抓取超时（秒）。'),
  maxResponseBytes: Schema.number().min(1024).max(4 * 1024 * 1024).default(1024 * 1024)
    .description('单次上游JSON体积上限（字节）。'),
});

export const API_PATH = '/dsh-earthquake-alert/api';
export const PREFERENCES_PATH = API_PATH + '/preferences';
export const REQUEST_HEADER = 'x-dsh-earthquake-alert';

const MAX_LIST = 200;
const USER_AGENT = 'dsh-earthquake-alert/0.1.0 (+local DSH plugin)';

function toNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toText(value, max = 200) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/gu, ' ').trim().slice(0, max) : '';
}

/** Wolfx CENC time is a timezone-less China Standard Time; never infer the machine timezone. */
export function parseSourceTime(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u);
  if (!match) return null;
  const date = new Date(value.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(date.getTime())) return null;
  const local = new Date(date.getTime() + 8 * 3600 * 1000);
  const fields = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()];
  if (fields.some((field, index) => field !== Number(match[index + 1]))) return null;
  return date;
}

function inRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** 上游 EEW 载荷 -> 只保留我们用得到的字段；形状不符即返回 null（宁可无数据，不造数据）。 */
export function normalizeEew(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'object') return null;
  const magnitude = toNumber(value.Magnitude);
  const latitude = toNumber(value.Latitude);
  const longitude = toNumber(value.Longitude);
  const eventId = toText(value.EventID, 128);
  const originTime = toText(value.OriginTime);
  const reportTime = toText(value.ReportTime) || originTime;
  const reportNum = toNumber(value.ReportNum);
  const depth = toNumber(value.Depth);
  const maxIntensity = toNumber(value.MaxIntensity);
  if (!eventId || !parseSourceTime(originTime) || !parseSourceTime(reportTime)
    || !inRange(magnitude, -2, 10) || !inRange(latitude, -90, 90) || !inRange(longitude, -180, 180)
    || !Number.isSafeInteger(reportNum) || reportNum < 0
    || (value.Depth != null && depth === undefined) || (depth !== undefined && !inRange(depth, 0, 800))
    || (value.MaxIntensity != null && maxIntensity === undefined) || (maxIntensity !== undefined && !inRange(maxIntensity, 0, 12))
    || parseSourceTime(reportTime).getTime() < parseSourceTime(originTime).getTime()) return null;
  return {
    eventId,
    originTime,
    reportTime,
    reportNum,
    place: toText(value.HypoCenter) || toText(value.PlaceName),
    magnitude,
    depth,
    latitude,
    longitude,
    maxIntensity,
  };
}

/** 上游速报目录（形如 { No1: {...}, No2: {...} } 或数组）-> 按发震时刻倒序的数组。 */
export function normalizeList(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const rows = Array.isArray(raw) ? raw : Object.values(raw);
  return rows
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      eventId: toText(row.EventID),
      time: toText(row.time) || toText(row.OriginTime),
      reportTime: toText(row.ReportTime),
      place: toText(row.location) || toText(row.placeName) || toText(row.HypoCenter),
      magnitude: toNumber(row.magnitude) ?? toNumber(row.Magnitude),
      depth: toNumber(row.depth) ?? toNumber(row.Depth),
      latitude: toNumber(row.latitude) ?? toNumber(row.Latitude),
      longitude: toNumber(row.longitude) ?? toNumber(row.Longitude),
      intensity: toNumber(row.intensity) ?? toNumber(row.MaxIntensity),
      type: toText(row.type),
    }))
    .filter(row => (row.eventId || row.place) && parseSourceTime(row.time)
      && inRange(row.magnitude, -2, 10) && inRange(row.latitude, -90, 90) && inRange(row.longitude, -180, 180)
      && (row.depth === undefined || inRange(row.depth, 0, 800)))
    .sort((a, b) => parseSourceTime(b.time).getTime() - parseSourceTime(a.time).getTime())
    .slice(0, MAX_LIST);
}

/**
 * 只接受本机同源、且带本插件专属请求头的请求。
 * 与 dsh-manual 的 trustedManualRequest 同一套口径：这个端点只服务本插件的页面。
 */
export function isTrustedRequest(req, trustedHosts = []) {
  const authority = req.headers?.host;
  if (typeof authority !== 'string') return false;
  let target;
  try { target = new URL('http://' + authority); } catch { return false; }
  if (target.host !== authority.toLowerCase() || target.username || target.password) return false;
  const loopback = target.hostname === 'localhost'
    || target.hostname === '[::1]'
    || /^127(?:\.(?:\d{1,3})){3}$/.test(target.hostname);
  const trusted = trustedHosts.some(entry => {
    try {
      const url = new URL('http://' + entry);
      return url.port ? url.host === target.host : url.hostname === target.hostname;
    } catch { return false; }
  });
  if (!loopback && !trusted) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== target.origin) return false;
  return req.headers[REQUEST_HEADER] === '1';
}

async function boundedJson(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw preferenceError('PAYLOAD_TOO_LARGE', '数据源响应超过体积上限。', 502);
  if (!response.body) throw preferenceError('INVALID_PAYLOAD', '数据源未返回JSON。', 502);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) throw preferenceError('PAYLOAD_TOO_LARGE', '数据源响应超过体积上限。', 502);
      chunks.push(Buffer.from(part.value));
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw preferenceError('INVALID_JSON', '数据源未返回有效JSON。', 502); }
}

async function fetchJson(url, timeoutMs, controller, maxBytes) {
  const timer = setTimeout(() => controller.abort(preferenceError('UPSTREAM_TIMEOUT', '数据源请求超时。', 504)), timeoutMs);
  try {
    const target = new URL(url);
    target.searchParams.set('_', String(Date.now()));
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!response.ok) throw Object.assign(new Error(`上游返回 HTTP ${response.status}`), { code: `HTTP_${response.status}` });
    return await boundedJson(response, maxBytes);
  } finally {
    clearTimeout(timer);
  }
}

/** Lower report numbers/times cannot replace a newer accepted event. Same-report corrections remain visible. */
export function isOlderReport(previous, next) {
  if (!previous) return false;
  if (previous.eventId === next.eventId) {
    return next.reportNum < previous.reportNum
      || parseSourceTime(next.reportTime).getTime() < parseSourceTime(previous.reportTime).getTime();
  }
  const previousOrigin = parseSourceTime(previous.originTime).getTime();
  const nextOrigin = parseSourceTime(next.originTime).getTime();
  return nextOrigin < previousOrigin
    || (nextOrigin === previousOrigin && parseSourceTime(next.reportTime).getTime() < parseSourceTime(previous.reportTime).getTime());
}

export function apply(ctx, config) {
  config = { eewUrl: 'https://api.wolfx.jp/cenc_eew.json', listUrl: 'https://api.wolfx.jp/cenc_eqlist.json', pollSeconds: 5, listSeconds: 60, timeoutSeconds: 12, maxResponseBytes: 1024 * 1024, ...config };
  for (const [key, min, max] of [['pollSeconds', 3, 300], ['listSeconds', 15, 3600], ['timeoutSeconds', 3, 60], ['maxResponseBytes', 1024, 4 * 1024 * 1024]]) {
    if (!inRange(config[key], min, max) || (key === 'maxResponseBytes' && !Number.isSafeInteger(config[key]))) throw new Error(`INVALID_CONFIG: ${key}`);
  }
  for (const key of ['eewUrl', 'listUrl']) {
    const target = new URL(config[key]);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error(`INVALID_CONFIG: ${key}`);
  }
  const logger = ctx.logger('dsh-earthquake-alert');
  const preferences = createPreferencesStore();
  const state = {
    eew: null,
    eewReceivedAt: 0,
    /** 同一条 EventID 的历次报告，用于展示「第 N 报」与参数更新。 */
    revisions: [],
    list: [],
    listUpdatedAt: 0,
    eewLastOkAt: 0,
    listLastOkAt: 0,
    eewError: null,
    listError: null,
    eewFetches: 0,
    listFetches: 0,
    errors: 0,
  };
  let disposed = false;
  const controllers = new Set();
  const tasks = new Set();
  const flights = new Map();

  const snapshot = () => ({
    serverTime: Date.now(),
    source: { eewUrl: config.eewUrl, listUrl: config.listUrl, pollSeconds: config.pollSeconds, listSeconds: config.listSeconds, timeoutSeconds: config.timeoutSeconds },
    health: {
      lastOkAt: Math.max(state.eewLastOkAt, state.listLastOkAt) || null,
      lastError: [state.eewError, state.listError].filter(Boolean).sort((a, b) => b.at - a.at)[0] || null,
      eewLastOkAt: state.eewLastOkAt || null,
      listLastOkAt: state.listLastOkAt || null,
      eewError: state.eewError,
      listError: state.listError,
      eewFetches: state.eewFetches,
      listFetches: state.listFetches,
      errors: state.errors,
    },
    eew: state.eew ? { ...state.eew, receivedAt: state.eewReceivedAt } : null,
    revisions: state.revisions.map(entry => ({ ...entry })),
    list: state.list.map(entry => ({ ...entry })),
    listUpdatedAt: state.listUpdatedAt || null,
  });

  const commitEew = next => {
      const previous = state.eew;
      if (parseSourceTime(next.originTime).getTime() > Date.now() || parseSourceTime(next.reportTime).getTime() > Date.now()) {
        throw preferenceError('FUTURE_REPORT', '数据源时间在未来，未作为活动事件接受。', 502);
      }
      if (isOlderReport(previous, next)) throw preferenceError('STALE_REPORT', '数据源返回较旧报告，未替换已接受数据。', 502);
      state.eew = next;
      state.eewReceivedAt = Date.now();
      const changed = !previous || previous.eventId !== next.eventId || previous.reportNum !== next.reportNum;
      if (changed) {
        state.revisions = [{
          at: state.eewReceivedAt,
          eventId: next.eventId,
          reportNum: next.reportNum,
          magnitude: next.magnitude,
          maxIntensity: next.maxIntensity,
          place: next.place,
          reportTime: next.reportTime,
        }, ...state.revisions.filter(entry => entry.eventId !== next.eventId || entry.reportNum !== next.reportNum)]
          .slice(0, 30);
        logger.info(`EEW 第 ${next.reportNum ?? 1} 报：${next.place || '(未知震中)'} M${next.magnitude ?? '?'}`);
      }
  };

  const refresh = feed => {
    if (disposed) return Promise.resolve();
    if (flights.has(feed)) return flights.get(feed);
    const controller = new AbortController();
    controllers.add(controller);
    state[feed + 'Fetches'] += 1;
    const task = (async () => {
      try {
        const raw = await fetchJson(config[feed === 'eew' ? 'eewUrl' : 'listUrl'], config.timeoutSeconds * 1000, controller, config.maxResponseBytes);
        if (disposed || controller.signal.aborted) return;
        const value = feed === 'eew' ? normalizeEew(raw) : normalizeList(raw);
        if (!value || (feed === 'list' && !value.length)) throw preferenceError('INVALID_PAYLOAD', '数据源字段无效，保留上一份数据。', 502);
        if (feed === 'eew') commitEew(value);
        else { state.list = value; state.listUpdatedAt = Date.now(); }
        state[feed + 'LastOkAt'] = Date.now();
        state[feed + 'Error'] = null;
      } catch (error) {
        if (disposed) return;
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        state[feed + 'Error'] = { code: failure?.code || 'UPSTREAM_UNAVAILABLE', message: String(failure?.message || failure).slice(0, 200), at: Date.now(), source: feed };
        state.errors += 1;
      } finally { controllers.delete(controller); }
    })();
    flights.set(feed, task);
    tasks.add(task);
    task.then(() => { flights.delete(feed); tasks.delete(task); }, () => { flights.delete(feed); tasks.delete(task); });
    return task;
  };

  ctx.inject(['webServer', 'webRuntime', 'connection'], inner => {
    inner.effect(() => {
      let closed = false;
      const requests = new Set();
      const tasks = new Set();
      const handler = preferenceRoute => (req, res) => {
          const task = (async () => {
            requests.add(req);
            const timer = setTimeout(() => req.destroy(), 15_000);
            const send = (status, body) => {
              if (res.destroyed || res.writableEnded) return;
              res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
              });
              res.end(JSON.stringify(body));
            };
            try {
              if (closed || disposed) return send(503, { ok: false, error: { code: 'UNAVAILABLE' } });
              if (!isTrustedRequest(req, inner.webRuntime?.trustedHosts ?? [])) return send(403, { ok: false, error: { code: 'FORBIDDEN' } });
              if (typeof inner.connection?.requestRejection !== 'function') return send(503, { ok: false, error: { code: 'AUTH_UNAVAILABLE' } });
              const rejection = inner.connection.requestRejection(req);
              if (rejection) return send(rejection === 401 ? 401 : 403, { ok: false, error: { code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' } });
              if (!preferenceRoute) {
                if (req.method !== 'GET') return send(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } });
                return send(200, { ok: true, value: snapshot() });
              }
              if (req.method === 'GET') return send(200, { ok: true, value: await preferences.read() });
              if (req.method !== 'POST') return send(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } });
              if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) return send(415, { ok: false, error: { code: 'CONTENT_TYPE_REQUIRED' } });
              const declared = Number(req.headers['content-length']);
              if (Number.isFinite(declared) && declared > MAX_PREFERENCES_BYTES) return send(413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
              const chunks = [];
              let length = 0;
              for await (const chunk of req) {
                length += Buffer.byteLength(chunk);
                if (length > MAX_PREFERENCES_BYTES) return send(413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
                chunks.push(Buffer.from(chunk));
              }
              let value;
              try { value = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
              catch { return send(400, { ok: false, error: { code: 'INVALID_JSON' } }); }
              return send(200, { ok: true, value: await preferences.save(value) });
            } catch (error) {
              send(error?.status || 500, { ok: false, error: { code: error?.code || 'SNAPSHOT_FAILED', message: error?.status ? String(error.message).slice(0, 200) : '读取或保存失败。' } });
            } finally { clearTimeout(timer); requests.delete(req); }
          })();
          tasks.add(task);
          task.then(() => tasks.delete(task), () => tasks.delete(task));
          return task;
      };
      const unregisterSnapshot = inner.webServer.register({
        kind: 'exact',
        path: API_PATH,
        handler: handler(false),
      });
      const unregisterPreferences = inner.webServer.register({ kind: 'exact', path: PREFERENCES_PATH, handler: handler(true) });
      return async () => {
        closed = true;
        unregisterSnapshot();
        unregisterPreferences();
        for (const req of requests) req.destroy();
        await Promise.allSettled([...tasks]);
      };
    }, 'dsh-earthquake-alert: 只读快照与鉴权偏好端点');
  });

  // Register the local endpoint first. Slow/unavailable third-party feeds never hold Loader activation hostage.
  ctx.effect(() => {
    const eewTimer = setInterval(() => { void refresh('eew'); }, config.pollSeconds * 1000);
    const listTimer = setInterval(() => { void refresh('list'); }, config.listSeconds * 1000);
    eewTimer.unref?.(); listTimer.unref?.();
    void refresh('eew'); void refresh('list');
    return async () => {
      disposed = true;
      clearInterval(eewTimer); clearInterval(listTimer);
      for (const controller of controllers) controller.abort(preferenceError('UNAVAILABLE', '插件正在卸载。', 503));
      await Promise.allSettled([...tasks]);
      await preferences.close();
    };
  }, 'dsh-earthquake-alert: 轮询与处置');
}
