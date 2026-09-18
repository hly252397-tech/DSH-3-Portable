export const SCHEMA = 1;
export const DEFAULT_BLACK_HOLE_ID = 'black-hole-default';
export const MAX_BLACK_HOLES = 64;
export const MAX_ENTRIES_PER_HOLE = 4000;
export const MAX_TITLE = 120;
export const MAX_BODY = 1024 * 1024;
export const ENTRY_TYPES = Object.freeze(['结论', '事实', '决策', '规则', '流程', '方案', '经验', '资料']);
export const ENTRY_STATUSES = Object.freeze(['candidate', 'confirmed', 'expired', 'conflict', 'archived']);

const LEVEL_NAMES = Object.freeze(['初生', '萌芽', '积累', '成长', '丰富', '充实', '广博', '深厚', '丰盈', '繁盛', '知识星海']);

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = 'bh') {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

export function clampText(value, max) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

export function normalizeSearch(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-Hans-CN').replace(/\s+/g, ' ').trim();
}

export function parseTags(value, max = 8) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[、,，;；\s]+/);
  const result = [];
  for (const item of raw) {
    const tag = clampText(item, 24);
    if (tag && !result.includes(tag)) result.push(tag);
    if (result.length >= max) break;
  }
  return result;
}

function chineseTerms(value) {
  const chars = [...value].filter((char) => /[\u3400-\u9fff]/u.test(char));
  const terms = [];
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= chars.length - size; index += 1) terms.push(chars.slice(index, index + size).join(''));
  }
  return terms;
}

export function tokenize(value) {
  const normalized = normalizeSearch(value);
  if (!normalized) return [];
  const words = normalized.match(/[a-z0-9_./-]+/g) ?? [];
  return [...new Set([...words, ...chineseTerms(normalized)])].slice(0, 240);
}

export function scoreMatch(query, fields) {
  const needle = normalizeSearch(query);
  if (!needle) return 0;
  const tokens = tokenize(needle);
  const text = normalizeSearch(fields.filter(Boolean).join(' '));
  if (!text) return 0;
  let score = text.includes(needle) ? 18 : 0;
  for (const token of tokens) {
    if (text.includes(token)) score += token.length > 2 ? 3 : 2;
  }
  return score;
}

export function snippet(value, query = '', max = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const needle = normalizeSearch(query);
  const at = needle ? normalizeSearch(text).indexOf(needle) : -1;
  const start = at > 48 ? at - 42 : 0;
  const body = text.slice(start, start + max);
  return `${start > 0 ? '…' : ''}${body}${start + max < text.length ? '…' : ''}`;
}

export function inferType(text, requested) {
  if (ENTRY_TYPES.includes(requested)) return requested;
  const value = normalizeSearch(text);
  if (/决策|决定|采用|选择|最终/.test(value)) return '决策';
  if (/规则|必须|不得|规范|标准|阈值/.test(value)) return '规则';
  if (/流程|步骤|先.*再|工作流|操作方法/.test(value)) return '流程';
  if (/方案|设计|架构|计划|建议/.test(value)) return '方案';
  if (/经验|教训|问题|原因|复盘/.test(value)) return '经验';
  if (/事实|已知|确认|数据|编号|版本/.test(value)) return '事实';
  return '资料';
}

export function makeTitle(text, requested) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s+/.test(line));
  if (heading) return clampText(heading.replace(/^#{1,6}\s+/, ''), MAX_TITLE);
  if (requested) return clampText(requested, MAX_TITLE);
  const first = lines[0] ?? '';
  return clampText(first.replace(/^[-*]\s+/, '').split(/[。！？!?]/u)[0], MAX_TITLE) || '未命名黑洞资料';
}

export function makeSummary(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^([-*•]|\d+[.)])\s+/.test(line)).slice(0, 4);
  if (bullets.length) return bullets.join(' ').slice(0, 360);
  return lines.join(' ').slice(0, 360);
}

export function inferTags(text, requested = []) {
  const value = normalizeSearch(text);
  const requestedTags = Array.isArray(requested) ? requested : String(requested ?? '').split(/[、,，;；\s]+/);
  const candidates = [
    ['产品', /产品|功能|规格|型号/],
    ['研发', /研发|开发|代码|架构|测试/],
    ['采购', /采购|供应商|报价|交期|物料/],
    ['项目', /项目|任务|里程碑|交付/],
    ['决策', /决策|决定|采用|选择/],
    ['流程', /流程|步骤|规范|制度/],
    ['风险', /风险|问题|冲突|异常/],
    ['会议', /会议|纪要|讨论/],
  ];
  return parseTags([...requestedTags, ...candidates.filter(([, pattern]) => pattern.test(value)).map(([tag]) => tag)]);
}

export function analyzeContent(content, options = {}) {
  const body = clampText(content, MAX_BODY);
  const title = makeTitle(body, options.title);
  return {
    title,
    summary: clampText(options.summary || makeSummary(body), 420),
    type: inferType(body, options.type),
    tags: inferTags(body, options.tags),
    valueScore: Math.min(100, Math.round((body.length / 80) + (body.includes('\n') ? 12 : 0) + (/结论|规则|决定|方案|流程/.test(body) ? 20 : 0))),
  };
}

function emptyGrowth() {
  return { score: 0, level: 0, label: LEVEL_NAMES[0], updatedAt: nowIso() };
}

export function calculateGrowth(hole) {
  const entries = Array.isArray(hole?.entries) ? hole.entries : [];
  const confirmed = entries.filter((entry) => entry.status === 'confirmed').length;
  const links = entries.reduce((total, entry) => total + (Array.isArray(entry.links) ? entry.links.length : 0), 0);
  const reused = entries.reduce((total, entry) => total + Number(entry.reuseCount || 0), 0);
  const score = Math.min(100, Math.round((entries.length * 1.4 + confirmed * 2.8 + links * 0.45 + reused * 1.7) * 10) / 10);
  const level = Math.min(10, Math.floor(score / 10));
  return { score, level, label: LEVEL_NAMES[level], updatedAt: nowIso() };
}

export function createDefaultState() {
  const createdAt = nowIso();
  const hole = {
    id: DEFAULT_BLACK_HOLE_ID,
    name: '黑洞空间',
    objective: '吸收并沉淀与当前任务有关的有价值内容。',
    description: '你的第一个黑洞。可以保存对话成果、资料和长期可复用的知识。',
    color: 'violet',
    brain: { mode: 'global', model: 'default', depth: 'balanced' },
    entries: [],
    activity: [],
    manual: { version: '0.1.0', status: 'alpha' },
    growth: emptyGrowth(),
    createdAt,
    updatedAt: createdAt,
  };
  return {
    version: SCHEMA,
    settings: { defaultBrain: { mode: 'global', model: 'default', depth: 'balanced' }, suggestions: 'balanced' },
    blackHoles: [hole],
    updatedAt: createdAt,
  };
}

function normalizeEntry(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid-entry');
  if (Buffer.byteLength(String(value.body ?? ''), 'utf8') > MAX_BODY) throw new Error('entry-too-large');
  const body = clampText(value.body, MAX_BODY);
  if (!body) throw new Error('empty-entry');
  const analyzed = analyzeContent(body, value);
  const status = ENTRY_STATUSES.includes(value.status) ? value.status : 'candidate';
  return {
    id: clampText(value.id, 160) || uid('memory'),
    title: analyzed.title,
    body,
    summary: analyzed.summary,
    type: analyzed.type,
    tags: analyzed.tags,
    status,
    confidence: Math.max(0, Math.min(1, Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : status === 'confirmed' ? 0.95 : 0.62)),
    valueScore: Math.max(0, Math.min(100, Number(value.valueScore) || analyzed.valueScore)),
    source: value.source && typeof value.source === 'object' ? {
      kind: clampText(value.source.kind, 40) || 'manual',
      label: clampText(value.source.label, 160),
      sessionId: clampText(value.source.sessionId, 160),
      filename: clampText(value.source.filename, 240),
    } : { kind: 'manual', label: '用户保存' },
    links: Array.isArray(value.links) ? [...new Set(value.links.map((item) => clampText(item, 160)).filter(Boolean))].slice(0, 32) : [],
    reuseCount: Math.max(0, Math.floor(Number(value.reuseCount) || 0)),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
  };
}

function normalizeHole(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid-black-hole');
  if (Array.isArray(value.entries) && value.entries.length > MAX_ENTRIES_PER_HOLE) throw new Error('too-many-entries');
  const entries = Array.isArray(value.entries) ? value.entries.slice(0, MAX_ENTRIES_PER_HOLE).map(normalizeEntry) : [];
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : nowIso();
  const hole = {
    id: clampText(value.id, 160) || uid('black-hole'),
    name: clampText(value.name, MAX_TITLE) || '未命名黑洞',
    objective: clampText(value.objective, 500),
    description: clampText(value.description, 1000),
    color: clampText(value.color, 24) || 'violet',
    brain: {
      mode: value.brain?.mode === 'custom' ? 'custom' : 'global',
      model: clampText(value.brain?.model, 160) || 'default',
      depth: ['fast', 'balanced', 'deep'].includes(value.brain?.depth) ? value.brain.depth : 'balanced',
    },
    entries,
    activity: Array.isArray(value.activity) ? value.activity.slice(-80).map((item) => ({
      id: clampText(item?.id, 160) || uid('event'),
      kind: clampText(item?.kind, 60),
      text: clampText(item?.text, 240),
      at: typeof item?.at === 'string' ? item.at : nowIso(),
    })) : [],
    manual: {
      version: clampText(value.manual?.version, 32) || '0.1.0',
      status: clampText(value.manual?.status, 32) || 'alpha',
    },
    growth: value.growth && typeof value.growth === 'object' ? value.growth : emptyGrowth(),
    createdAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : createdAt,
  };
  hole.growth = calculateGrowth(hole);
  return hole;
}

export function normalizeState(value) {
  if (!value || typeof value !== 'object' || Number(value.version) !== SCHEMA) throw new Error('invalid-state');
  if (Array.isArray(value.blackHoles) && value.blackHoles.length > MAX_BLACK_HOLES) throw new Error('too-many-black-holes');
  const rawHoles = Array.isArray(value.blackHoles) ? value.blackHoles.slice(0, MAX_BLACK_HOLES) : [];
  const blackHoles = rawHoles.map(normalizeHole);
  if (!blackHoles.length) blackHoles.push(createDefaultState().blackHoles[0]);
  const ids = new Set();
  for (const hole of blackHoles) {
    if (ids.has(hole.id)) throw new Error('duplicate-black-hole-id');
    ids.add(hole.id);
    const entryIds = new Set();
    for (const entry of hole.entries) {
      if (entryIds.has(entry.id)) throw new Error('duplicate-entry-id');
      entryIds.add(entry.id);
    }
  }
  return {
    version: SCHEMA,
    settings: {
      defaultBrain: {
        mode: value.settings?.defaultBrain?.mode === 'custom' ? 'custom' : 'global',
        model: clampText(value.settings?.defaultBrain?.model, 160) || 'default',
        depth: ['fast', 'balanced', 'deep'].includes(value.settings?.defaultBrain?.depth) ? value.settings.defaultBrain.depth : 'balanced',
      },
      suggestions: ['quiet', 'balanced', 'active'].includes(value.settings?.suggestions) ? value.settings.suggestions : 'balanced',
    },
    blackHoles,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
  };
}

export function searchEntries(state, query, options = {}) {
  const needle = normalizeSearch(query);
  if (!needle) return [];
  const holeId = options.blackHoleId;
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  const rows = [];
  for (const hole of state?.blackHoles || []) {
    if (holeId && hole.id !== holeId) continue;
    for (const entry of hole.entries || []) {
      const score = scoreMatch(needle, [entry.title, entry.summary, entry.body, ...(entry.tags || [])]);
      if (score <= 0) continue;
      rows.push({ blackHoleId: hole.id, blackHoleName: hole.name, entry, score, snippet: snippet(entry.body, needle) });
    }
  }
  return rows.sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt)).slice(0, limit);
}

export function addEntry(state, blackHoleId, value) {
  const hole = state.blackHoles.find((item) => item.id === blackHoleId);
  if (!hole) throw new Error('black-hole-not-found');
  const entry = normalizeEntry(value);
  const duplicate = hole.entries.find((item) => normalizeSearch(item.body) === normalizeSearch(entry.body));
  if (duplicate) return { state, entry: duplicate, duplicate: true };
  hole.entries.unshift(entry);
  hole.activity.push({ id: uid('event'), kind: 'absorbed', text: `吸收：${entry.title}`, at: nowIso() });
  hole.activity = hole.activity.slice(-80);
  hole.growth = calculateGrowth(hole);
  hole.updatedAt = nowIso();
  state.updatedAt = hole.updatedAt;
  return { state, entry, duplicate: false };
}

export function updateEntry(state, blackHoleId, entryId, patch) {
  const hole = state.blackHoles.find((item) => item.id === blackHoleId);
  const index = hole?.entries.findIndex((item) => item.id === entryId) ?? -1;
  if (!hole || index < 0) throw new Error('entry-not-found');
  const next = normalizeEntry({ ...hole.entries[index], ...patch, updatedAt: nowIso() });
  hole.entries[index] = next;
  hole.activity.push({ id: uid('event'), kind: 'updated', text: `更新：${next.title}`, at: nowIso() });
  hole.activity = hole.activity.slice(-80);
  hole.growth = calculateGrowth(hole);
  hole.updatedAt = nowIso();
  state.updatedAt = hole.updatedAt;
  return next;
}

export function markReused(state, blackHoleId, entryId) {
  const hole = state.blackHoles.find((item) => item.id === blackHoleId);
  const entry = hole?.entries.find((item) => item.id === entryId);
  if (!hole || !entry) return false;
  entry.reuseCount += 1;
  entry.updatedAt = nowIso();
  hole.growth = calculateGrowth(hole);
  hole.updatedAt = nowIso();
  state.updatedAt = hole.updatedAt;
  return true;
}

export function levelName(level) {
  return LEVEL_NAMES[Math.max(0, Math.min(10, Number(level) || 0))];
}
