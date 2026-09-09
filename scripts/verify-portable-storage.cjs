const assert = require('node:assert/strict');
const { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { chromium } = require(process.env.DSH_QA_PLAYWRIGHT);
const qaHome = 'G:\\DSH-3-Portable\\Data\\Updates\\Desktop\\diagnostics\\qoder-ui-manual-smoke\\Data\\DSH';
const artifacts = resolve('artifacts/portable-storage-20260905');
const marker = join(artifacts, 'cross-port-report.json');
const key = 'dsh.spaceTabs.v1.knowledge';
const dbKey = 'dsh.spaceTabs.v1.database';
const fixture = { version: 1, collections: [{ id: 'portable-qa', title: '工程手册', workspaceId: '' }], entries: [{ id: 'portable-entry', collectionId: 'portable-qa', title: '跨端口验证', body: '原浏览器知识', tags: ['验证'] }] };
const database = { version: 1, fields: [{ id: 'portable-field', name: '名称', type: 'text' }], records: [{ id: 'portable-record', cells: { 'portable-field': '原浏览器记录' } }] };
(async () => {
  assert.equal(process.env.DSH_STORAGE_QA_HOME, qaHome, 'only the explicitly isolated test home is permitted');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9237');
  try {
    const page = await Promise.any(browser.contexts().flatMap(c => c.pages()).map(async page => {
      await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 30000 }); return page;
    }));
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const call = (action, space, rest = {}) => page.evaluate(async ({ action, space, rest }) => {
      const r = await fetch('/sidebar-spaces/api/store', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-spaces': '1' }, body: JSON.stringify({ action, space, ...rest }) });
      return { status: r.status, ...await r.json() };
    }, { action, space, rest });
    const enter = async () => {
      const defer = page.getByRole('button', { name: '稍后配置', exact: true });
      await defer.waitFor({ timeout: 2000 }).catch(() => {});
      if (await defer.isVisible()) await defer.click();
      await page.getByRole('button', { name: '知识中心', exact: true }).click();
      await page.locator('.dss-kb-card').filter({ hasText: '工程手册' }).waitFor();
    };
    if (process.argv[2] === 'seed') {
      if (await page.getByRole('button', { name: '返回工作区', exact: true }).isVisible()) await page.getByRole('button', { name: '返回工作区', exact: true }).click();
      const file = join(qaHome, 'workbench/sidebar-spaces/workbench.sqlite');
      assert.ok(resolve(file).startsWith(resolve(qaHome) + '\\'));
      mkdirSync(artifacts, { recursive: true });
      // Recoverable move of isolated test data only; never remove a real user's store.
      if (existsSync(file)) renameSync(file, join(artifacts, 'diagnostic-store-before-' + Date.now() + '.sqlite'));
      await page.evaluate(({ key, dbKey, fixture, database }) => {
        localStorage.setItem(key, JSON.stringify(fixture)); localStorage.setItem(dbKey, JSON.stringify(database));
      }, { key, dbKey, fixture, database });
      await page.reload(); await enter();
      assert.deepEqual((await call('load', 'knowledge')).value.data, fixture);
      assert.deepEqual((await call('load', 'database')).value.data, database);
      assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), fixture, 'legacy source retained');
      await page.getByPlaceholder('全局搜索知识条目和数据库记录').fill('跨端口验证');
      await page.locator('.dss-item').filter({ hasText: '跨端口验证' }).click();
      await page.getByLabel('正文', { exact: true }).fill('界面保存后跨端口保留');
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.locator('.dss-drawer').waitFor({ state: 'detached' });
      assert.equal((await call('load', 'knowledge')).value.data.entries[0].body, '界面保存后跨端口保留');
      await page.locator('.dss-item').filter({ hasText: '跨端口验证' }).click();
      await page.getByLabel('正文', { exact: true }).fill('保存失败时保留的草稿');
      await page.route('**/sidebar-spaces/api/store', async route => {
        if (route.request().postDataJSON().action === 'save') {
          await new Promise(resolve => setTimeout(resolve, 150));
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'storage-unavailable' } }) });
        } else await route.continue();
      });
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '保存未确认' }).waitFor();
      assert.equal(await page.getByLabel('正文', { exact: true }).inputValue(), '保存失败时保留的草稿');
      await page.unroute('**/sidebar-spaces/api/store');
      assert.equal((await call('load', 'knowledge')).value.data.entries[0].body, '界面保存后跨端口保留');
      await page.reload(); await enter();
      await page.getByPlaceholder('全局搜索知识条目和数据库记录').fill('跨端口验证');
      await page.locator('.dss-item').filter({ hasText: '跨端口验证' }).click();
      await page.getByLabel('正文', { exact: true }).fill('冲突时保留的本地草稿');
      const current = (await call('load', 'knowledge')).value;
      current.data.entries[0].body = '另一窗口已提交的版本';
      assert.equal((await call('save', 'knowledge', current)).status, 200);
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '另一窗口已修改数据' }).waitFor();
      assert.equal(await page.getByLabel('正文', { exact: true }).inputValue(), '冲突时保留的本地草稿');
      assert.equal((await call('load', 'knowledge')).value.data.entries[0].body, '另一窗口已提交的版本');
      await page.reload(); await enter();
      await page.getByRole('button', { name: '数据库', exact: true }).click();
      const cell = page.locator('.dss-cell-input').first();
      await cell.fill('跨端口表格记录'); await cell.blur();
      await page.getByText('已提交数据保存在便携盘；表格输入移开焦点后保存。', { exact: true }).waitFor();
      assert.equal((await call('load', 'database')).value.data.records[0].cells['portable-field'], '跨端口表格记录');
      const anonymous = await fetch(new URL('/sidebar-spaces/api/store', page.url()), { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-spaces': '1' }, body: JSON.stringify({ action: 'load', space: 'knowledge' }) });
      assert.equal(anonymous.status, 401, 'authentication required even on localhost');
      writeFileSync(marker, JSON.stringify({ beforeOrigin: new URL(page.url()).origin, phase: 'seed-pass' }, null, 2));
      console.log('PASS migration, UI save, retained legacy, conflict guard/draft, database save, unauthenticated 401. Restart isolated host for verify phase.');
    } else {
      const report = JSON.parse(readFileSync(marker, 'utf8'));
      const origin = new URL(page.url()).origin;
      assert.notEqual(origin, report.beforeOrigin, 'restart must use a different port');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, 'new origin has no browser knowledge');
      await enter();
      await page.getByPlaceholder('全局搜索知识条目和数据库记录').fill('另一窗口已提交的版本');
      await page.locator('.dss-item').filter({ hasText: '跨端口验证' }).waitFor();
      await page.getByRole('button', { name: '数据库', exact: true }).click();
      assert.equal(await page.locator('.dss-cell-input').first().inputValue(), '跨端口表格记录');
      await page.screenshot({ path: join(artifacts, 'cross-port-passed.png') });
      writeFileSync(marker, JSON.stringify({ ...report, afterOrigin: origin, phase: 'cross-port-pass' }, null, 2));
      console.log('PASS actual host restart + changed port + empty browser storage retain knowledge and database.');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
