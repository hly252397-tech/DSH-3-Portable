// Boot Circuit Breaker —— 任务单第十八节。
//
// 目的：把「这次到底有没有 BOOT_FAILED」变成机器判定，而不是靠人看截图。
// 出现任一条件立即 BOOT_FAILED + CURRENT_CANDIDATE_REJECTED，然后走：
//   冻结 Candidate -> 停止业务修改 -> 保存第一条真实错误 -> 保存第一个失败请求
//   -> 回滚 Stable -> 验证 Stable 冷启动 -> 创建 Recovery Candidate -> 二分定位共享根因
//
// 禁止：逐个修插件 / 把 required 改 optional / try-catch 隐藏错误 / 降低启动门禁 /
//       在坏 Candidate 上继续功能开发。
import { nowIso } from './paths.mjs';

/** 第十八节要求的必需核心服务。 */
export const REQUIRED_CORE_SERVICES = Object.freeze(['locale', 'settingsScope', 'slots']);

/** 插件家族归属：优先用显式 family，否则每个插件各自成族（保守：避免把无关算成相关）。 */
function familyOf(plugin) {
  return plugin.family || plugin.name;
}

/**
 * @param {object} input
 * @param {Array}  input.plugins        [{ name, status: 'ok'|'import_failed', required?: bool, family? }]
 * @param {Array}  input.services       [{ name, ready: bool, timedOut?: bool }]
 * @param {Array}  input.moduleRequests [{ url, status, contentType }]
 * @param {Array}  input.sharedModules  [{ name, loaded: bool }]
 * @param {Error|string|null} input.loaderException
 * @param {boolean} input.bootCompleted
 * @param {Array}  input.corePlugins    必需的宿主核心插件名
 */
export function evaluateBoot({
  plugins = [],
  services = null,
  moduleRequests = [],
  sharedModules = [],
  loaderException = null,
  bootCompleted = null,
  corePlugins = [],
} = {}) {
  const triggers = [];
  const unverified = [];

  const failed = plugins.filter((p) => p.status === 'import_failed');
  const failedFamilies = [...new Set(failed.map(familyOf))];

  // 规则 1：两个以上「无关」插件同时 import failed
  if (failedFamilies.length >= 2) {
    triggers.push({
      rule: 'two_unrelated_plugins_import_failed',
      detail: `import_failed=${failed.length}, distinct_families=${failedFamilies.length}`,
      plugins: failed.map((p) => p.name),
    });
  }
  // 规则 2：任一 required core plugin import failed
  const requiredFailed = failed.filter((p) => p.required === true || corePlugins.includes(p.name));
  if (requiredFailed.length) {
    triggers.push({ rule: 'required_core_plugin_import_failed', detail: requiredFailed.map((p) => p.name).join(',') });
  }
  // 规则 3：locale / settingsScope / slots 超时未 ready
  // services === null 表示**观测不到**：此时绝不放行，也绝不假装通过——
  // 记为 unverified_checks，由调用方决定是否接受 PARTIAL 结论。
  let notReady = [];
  if (services === null || services === undefined) {
    unverified.push('core_service_not_ready');
  } else {
    const svc = new Map(services.map((s) => [s.name, s]));
    notReady = REQUIRED_CORE_SERVICES.filter((n) => {
      const s = svc.get(n);
      return !s || s.ready !== true || s.timedOut === true;
    });
    if (notReady.length) {
      triggers.push({ rule: 'core_service_not_ready', detail: notReady.join(','), services: notReady });
    }
  }
  // 规则 4：公共模块无法加载
  const unloadedShared = (sharedModules || []).filter((m) => m.loaded !== true);
  if (unloadedShared.length) {
    triggers.push({ rule: 'shared_module_not_loaded', detail: unloadedShared.map((m) => m.name).join(',') });
  }
  // 规则 5：模块 URL 404
  const notFound = (moduleRequests || []).filter((r) => Number(r.status) === 404);
  if (notFound.length) {
    triggers.push({ rule: 'module_url_404', detail: notFound.map((r) => r.url).join(',') });
  }
  // 规则 6：模块请求返回 HTML（SPA fallback 把 JS 当 index.html 返回的经典故障）
  const htmlForModule = (moduleRequests || []).filter((r) => {
    const ct = String(r.contentType || '').toLowerCase();
    return ct.includes('text/html') && /\.(m?js|cjs)(\?|$)/i.test(String(r.url || ''));
  });
  if (htmlForModule.length) {
    triggers.push({ rule: 'module_request_returned_html', detail: htmlForModule.map((r) => r.url).join(',') });
  }
  // 规则 7：插件加载器自身异常
  if (loaderException) {
    triggers.push({
      rule: 'plugin_loader_exception',
      detail: typeof loaderException === 'string' ? loaderException : String(loaderException.message || loaderException),
    });
  }
  // 规则 8：Web boot 未完成（null/undefined = 观测不到，记入 unverified 而不是默认放行）
  if (bootCompleted === null || bootCompleted === undefined) {
    unverified.push('web_boot_not_completed');
  } else if (bootCompleted !== true) {
    triggers.push({ rule: 'web_boot_not_completed', detail: 'bootCompleted=false' });
  }

  // 保存第一条真实错误 / 第一个失败请求（取证顺序敏感：必须是**第一条**）
  const firstError = failed.length
    ? { source: 'plugin_import', plugin: failed[0].name, at: nowIso() }
    : loaderException
      ? { source: 'loader_exception', message: String(loaderException.message || loaderException), at: nowIso() }
      : notReady.length
        ? { source: 'core_service', service: notReady[0], at: nowIso() }
        : null;
  const firstFailedRequest =
    (moduleRequests || []).find((r) => Number(r.status) >= 400 || String(r.contentType || '').toLowerCase().includes('text/html')) || null;

  const status = triggers.length ? 'BOOT_FAILED' : 'OK';
  return {
    status,
    checked_at: nowIso(),
    triggers,
    unverified_checks: unverified,
    verdict_completeness: unverified.length ? 'PARTIAL' : 'FULL',
    first_error: firstError,
    first_failed_request: firstFailedRequest,
    candidate_action: status === 'BOOT_FAILED' ? 'CURRENT_CANDIDATE_REJECTED' : 'NONE',
    // 明确写出被禁止的逃生舱，供门禁脚本断言（防止有人「顺手」加进去）
    forbidden_remedies: [
      'fix_plugins_one_by_one',
      'downgrade_required_to_optional',
      'swallow_error_with_try_catch',
      'lower_boot_gate',
      'continue_feature_work_on_broken_candidate',
    ],
    recovery_plan: status === 'BOOT_FAILED'
      ? [
          'freeze_candidate',
          'stop_business_changes',
          'save_first_real_error',
          'save_first_failed_request',
          'rollback_stable',
          'verify_stable_cold_boot',
          'create_recovery_candidate',
          'bisect_shared_root_cause',
        ]
      : [],
  };
}
