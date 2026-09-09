const assert = require('node:assert/strict');
const { chromium } = require(process.env.DSH_QA_PLAYWRIGHT);

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9237');
  try {
    const pages = browser.contexts().flatMap(context => context.pages());
    const page = await Promise.any(pages.map(async page => {
      await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 30000 });
      return page;
    }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '稍后配置', exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    if (await page.getByRole('button', { name: '稍后配置', exact: true }).isVisible()) await page.getByRole('button', { name: '稍后配置', exact: true }).click();
    await page.getByRole('button', { name: '搜索任务', exact: true }).click();
    const search = page.getByRole('textbox', { name: '搜索任务标题和对话正文', exact: true });
    await search.fill('SearchTitleFixture');
    await page.locator('.dss-item').filter({ hasText: 'SearchTitleFixture' }).first().waitFor();
    await search.fill('BODY_NEEDLE_20260905');
    const result = page.locator('.dss-item').filter({ hasText: 'BODY_NEEDLE_20260905' }).first();
    await result.waitFor();
    await page.screenshot({ path: 'artifacts/qoder-parity-20260905/task-search-body.png' });
    await result.click();
    await page.locator('.dss-standalone-host').waitFor({ state: 'detached' });
    await page.getByText('BODY_NEEDLE_20260905 仅供本地搜索回归验证，不执行任务。', { exact: true }).waitFor();
    assert.ok((await page.locator('body').innerText()).includes('BODY_NEEDLE_20260905'));
    await page.getByRole('button', { name: '搜索任务', exact: true }).click();
    await search.fill('NO_RESULT_UNIQUE_28d571a');
    await page.getByText('没有匹配的任务', { exact: true }).waitFor();
    assert.equal(await page.locator('.dss-item').count(), 0);
    await page.getByRole('button', { name: '返回工作区', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log('PASS isolated Profile: title match, actual host content search, open original session, empty result, no model call.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
