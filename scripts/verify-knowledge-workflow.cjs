const assert = require('node:assert/strict');
const { chromium } = require(process.env.DSH_QA_PLAYWRIGHT);

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9237');
  const page = browser.contexts().flatMap(context => context.pages()).find(page => /^http:\/\/127\.0\.0\.1:/.test(page.url()));
  assert.ok(page, 'isolated Profile renderer must exist');
  const key = 'dsh.spaceTabs.v1.knowledge';
  const original = await page.evaluate(key => localStorage.getItem(key), key);
  const prior = await page.evaluate(key => localStorage.getItem(key + '.prev'), key);
  const call = (action, rest = {}) => page.evaluate(async ({ action, rest }) => {
    const response = await fetch('/sidebar-spaces/api/store', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-spaces': '1' }, body: JSON.stringify({ action, space: 'knowledge', ...rest }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error?.code);
    return result.value;
  }, { action, rest });
  const originalHost = await call('load');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    if (await page.getByRole('button', { name: '稍后配置', exact: true }).isVisible()) await page.getByRole('button', { name: '稍后配置', exact: true }).click();
    await page.getByRole('button', { name: '知识中心', exact: true }).click();
    await page.getByRole('button', { name: '创建知识库', exact: true }).click();
    await page.getByLabel('知识库名称', { exact: true }).fill('功能验收临时库');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const card = page.locator('.dss-kb-card').filter({ hasText: '功能验收临时库' });
    await card.waitFor();
    await card.click();
    const before = (await call('load')).data.entries.length;
    await page.getByRole('button', { name: '新建条目', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal((await call('load')).data.entries.length, before, 'cancel must not persist draft');
    await page.getByRole('button', { name: '新建条目', exact: true }).click();
    await page.getByLabel('标题', { exact: true }).fill('机械设计验证');
    await page.getByLabel('正文', { exact: true }).fill('Inventor 齿轮知识跨库检索');
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '管理知识库', exact: true }).click();
    await page.getByRole('button', { name: '删除空知识库', exact: true }).click();
    await page.getByText('请先移动或删除库内条目；不会连带删除知识。', { exact: true }).waitFor();
    await page.getByLabel('知识库名称', { exact: true }).fill('功能验收已重命名');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByPlaceholder('全局搜索知识条目和数据库记录').fill('齿轮');
    await page.locator('.dss-item').filter({ hasText: '机械设计验证' }).click();
    await page.getByLabel('所属知识库', { exact: true }).selectOption({ label: '工程手册' });
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: '稍后配置', exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    if (await page.getByRole('button', { name: '稍后配置', exact: true }).isVisible()) await page.getByRole('button', { name: '稍后配置', exact: true }).click();
    await page.getByRole('button', { name: '知识中心', exact: true }).click();
    await page.locator('.dss-kb-card').filter({ hasText: '功能验收已重命名' }).waitFor();
    const saved = (await call('load')).data;
    const entry = saved.entries.find(entry => entry.title === '机械设计验证');
    assert.equal(saved.collections.find(collection => collection.id === entry.collectionId).title, '工程手册');
    await page.locator('.dss-kb-card').filter({ hasText: '功能验收已重命名' }).click();
    await page.getByRole('button', { name: '管理知识库', exact: true }).click();
    await page.getByRole('button', { name: '删除空知识库', exact: true }).click();
    await page.locator('.dss-kb-card').filter({ hasText: '功能验收已重命名' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.dss-kb-card').filter({ hasText: '功能验收已重命名' }).count(), 0);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    await page.getByRole('button', { name: '自动化', exact: true }).first().click();
    await page.getByRole('button', { name: '打开定时任务管理', exact: true }).click();
    await page.locator('[role="dialog"] nav button').filter({ hasText: /定时任务|Scheduled tasks/ }).waitFor();
    await page.screenshot({ path: 'artifacts/functional-automation-20260905.png' });
    assert.deepEqual(errors, []);
    console.log('PASS real Profile/Loader: create/rename collection, cancel draft, save, search, move, reload, safe empty deletion, automation navigation.');
  } finally {
    if (originalHost.data) {
      const current = await call('load');
      await call('save', { revision: current.revision, data: originalHost.data });
    }
    await page.evaluate(({ key, original, prior }) => {
      if (original === null) localStorage.removeItem(key); else localStorage.setItem(key, original);
      if (prior === null) localStorage.removeItem(key + '.prev'); else localStorage.setItem(key + '.prev', prior);
    }, { key, original, prior });
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
