import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyEmbeddedBrowserGuest, EMBEDDED_BROWSER_CHROME_PARTITION, EMBEDDED_BROWSER_PAGE_PARTITION } from '../src/embedded-browser-guest.js'

const chromeUrl = 'file:///G:/DSH-3-Portable/assets/browser-panel.html'

test('embedded browser admits only the owned chrome and web page partitions', () => {
  assert.equal(classifyEmbeddedBrowserGuest(chromeUrl, EMBEDDED_BROWSER_CHROME_PARTITION, chromeUrl), 'chrome')
  assert.equal(classifyEmbeddedBrowserGuest('https://login.hongjian.com/login/login.jsp', EMBEDDED_BROWSER_PAGE_PARTITION, chromeUrl), 'page')
  assert.equal(classifyEmbeddedBrowserGuest('http://127.0.0.1:8765/', EMBEDDED_BROWSER_PAGE_PARTITION, chromeUrl), 'page')
  assert.equal(classifyEmbeddedBrowserGuest(chromeUrl, EMBEDDED_BROWSER_PAGE_PARTITION, chromeUrl), 'reject')
  assert.equal(classifyEmbeddedBrowserGuest('file:///G:/other.html', EMBEDDED_BROWSER_CHROME_PARTITION, chromeUrl), 'reject')
  assert.equal(classifyEmbeddedBrowserGuest('javascript:alert(1)', EMBEDDED_BROWSER_PAGE_PARTITION, chromeUrl), 'reject')
  assert.equal(classifyEmbeddedBrowserGuest('data:text/html,hi', EMBEDDED_BROWSER_PAGE_PARTITION, chromeUrl), 'reject')
  assert.equal(classifyEmbeddedBrowserGuest('https://example.com', 'persist:arbitrary', chromeUrl), 'reject')
})
