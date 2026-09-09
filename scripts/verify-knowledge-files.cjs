const assert = require('node:assert/strict');
const { chromium } = require(process.env.DSH_QA_PLAYWRIGHT);

(async () => {
  assert.match(process.env.DSH_STORAGE_QA_HOME || '', /diagnostics[\\/]qoder-ui-manual-smoke[\\/]Data[\\/]DSH$/);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9237');
  const page = browser.contexts().flatMap(context => context.pages()).find(page => /^http:\/\/127\.0\.0\.1:/.test(page.url()));
  assert.ok(page, 'isolated renderer must exist');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const call = (action, rest = {}) => page.evaluate(async ({ action, rest }) => {
    const response = await fetch('/sidebar-spaces/api/store', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-spaces': '1' }, body: JSON.stringify({ action, space: 'knowledge', ...rest }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error?.code);
    return result.value;
  }, { action, rest });
  const original = await call('load');
  assert.ok(original.data, 'use an initialized diagnostic store');
  const open = async () => {
    await page.reload();
    const skip = page.getByRole('button', { name: '稍后配置', exact: true });
    await skip.waitFor({ timeout: 2500 }).catch(() => {});
    if (await skip.isVisible()) await skip.click();
    await page.getByRole('button', { name: '知识中心', exact: true }).click();
    await page.locator('.dss-kb-card').first().click();
    await page.getByRole('button', { name: '添加文件', exact: true }).waitFor();
  };
  const upload = async (name, buffer) => {
    const chosen = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '添加文件', exact: true }).click();
    await (await chosen).setFiles({ name, mimeType: 'text/plain', buffer });
  };
  const finish = async () => {
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.locator('#dss-kb-body').waitFor({ state: 'detached' });
  };
  try {
    await open();
    const body = '# 长资料测试\r\n' + '知识来源😀\n'.repeat(1500) + '\n尾部检索唯一词-Refinement-20260905\n<script>window.__kbExecuted = true</script>';
    await upload('功能细化资料.md', Buffer.from(body));
    await page.locator('#dss-kb-body').waitFor();
    assert.equal(await page.locator('#dss-kb-body').inputValue(), body.replaceAll('\r\n', '\n'), 'textarea normalizes CRLF');
    assert.equal((await call('load')).data.entries.length, original.data.entries.length, 'preview is not saved');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal((await call('load')).data.entries.length, original.data.entries.length, 'cancel is not saved');
    await upload('功能细化资料.md', Buffer.from(body));
    await page.locator('#dss-kb-body').waitFor();
    await finish();
    let saved = (await call('load')).data.entries.find(entry => entry.title === '功能细化资料');
    assert.equal(saved.body, body, 'file body is preserved byte-for-text including CRLF until edited');
    assert.equal(saved.source.filename, '功能细化资料.md');
    assert.equal(await page.evaluate(() => window.__kbExecuted), undefined, 'source HTML is not executed');
    await upload('同内容.txt', Buffer.from(body));
    await page.locator('#dss-kb-body').waitFor();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByText(/该知识库已有相同正文/).waitFor();
    assert.equal((await call('load')).data.entries.length, original.data.entries.length + 1);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await open();
    await page.getByPlaceholder('全局搜索知识条目和数据库记录').fill('尾部检索唯一词-Refinement-20260905');
    await page.locator('.dss-item').filter({ hasText: '功能细化资料' }).click();
    await page.waitForFunction(() => document.querySelector('#dss-kb-body')?.value.includes('尾部检索唯一词-Refinement-20260905'));
    assert.ok((await page.locator('#dss-kb-body').inputValue()).includes('尾部检索唯一词-Refinement-20260905'));
    await page.locator('#dss-kb-title').fill('功能细化资料-改名');
    await finish();
    saved = (await call('load')).data.entries.find(entry => entry.title === '功能细化资料-改名');
    assert.equal(saved.body, body, 'renaming must not truncate existing long body');
    await page.screenshot({ path: 'artifacts/feature-refinement-20260905/knowledge-file-search.png' });
    await page.getByPlaceholder('全局搜索知识条目和数据库记录').fill('');
    await upload('invalid.txt', Buffer.from([0xff, 0xfe]));
    await page.getByText(/无法按 UTF-8/).waitFor();
    await upload('large.txt', Buffer.alloc(262145, 65));
    await page.getByText(/文件超过 256 KiB/).waitFor();
    await upload('empty.txt', Buffer.from(' \n'));
    await page.getByText(/文件没有可导入/).waitFor();
    await upload('wrong.pdf', Buffer.from('not a PDF'));
    await page.getByText(/暂不支持此格式/).waitFor();
    const failureBody = '失败时必须保留资料草稿';
    await upload('失败保留.txt', Buffer.from(failureBody));
    await page.locator('#dss-kb-body').waitFor();
    await page.route('**/sidebar-spaces/api/store', async route => {
      if (route.request().postDataJSON()?.action === 'save') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'storage-unavailable' } }) });
      else await route.continue();
    });
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '保存未确认' }).waitFor();
    assert.equal(await page.locator('#dss-kb-body').inputValue(), failureBody);
    assert.equal((await call('load')).data.entries.length, original.data.entries.length + 1);
    await page.unroute('**/sidebar-spaces/api/store');
    await open();
    const backupText = '备份长正文'.repeat(2000);
    const payload = { app: 'dsh-sidebar-spaces', space: 'knowledge', schema: 1, data: { ...original.data, entries: [{ id: 'refinement-backup-fixture', collectionId: original.data.collections[0].id, title: '长备份验收', body: backupText, tags: [] }] } };
    const chosen = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '导入备份', exact: true }).click();
    await (await chosen).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await page.getByText('已导入 1 条条目', { exact: true }).waitFor();
    assert.equal((await call('load')).data.entries.find(row => row.id === 'refinement-backup-fixture').body, backupText);
    assert.deepEqual(errors, []);
    console.log('PASS real Profile/Loader: file chooser, preview/cancel, UTF-8, full long body, deduplication, reload/search, title-only edit, source safety, invalid/large/empty/unsupported files, failed save draft, full JSON backup import.');
  } finally {
    await page.unroute('**/sidebar-spaces/api/store');
    const current = await call('load');
    await call('save', { revision: current.revision, data: original.data });
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
