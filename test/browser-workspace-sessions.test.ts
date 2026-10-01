import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSavedBrowserSessions, normalizeSavedBrowserTabs } from '../src/browser-workspace-sessions.js'

test('browser workspace restore keeps only safe, distinct web tabs', () => {
  const tabs = normalizeSavedBrowserTabs([
    { id: 'a', title: 'ERP', url: 'http://127.0.0.1:8975/index.html' },
    { id: 'a', title: 'duplicate', url: 'https://example.com' },
    { id: 'b', title: 'local file', url: 'file:///C:/secret' },
    { id: 'c', title: 'script', url: 'javascript:alert(1)' },
    { id: 'd', title: 'Web', url: 'https://example.com/path' },
  ])
  assert.deepEqual(tabs.map(tab => [tab.id, tab.url]), [
    ['a', 'http://127.0.0.1:8975/index.html'],
    ['d', 'https://example.com/path'],
  ])
})

test('browser workspace restores each session bucket and its own active tab', () => {
  const sessions = normalizeSavedBrowserSessions({
    sessionA: { activeTabId: 'erp', tabs: [{ id: 'erp', title: 'ERP', url: 'http://127.0.0.1:8975/' }] },
    sessionB: { activeTabId: 'missing', tabs: [{ id: 'docs', title: 'Docs', url: 'https://example.com/docs' }] },
  })
  assert.equal(sessions.get('sessionA')?.activeTabId, 'erp')
  assert.deepEqual(sessions.get('sessionA')?.tabs.map(tab => tab.id), ['erp'])
  assert.equal(sessions.get('sessionB')?.activeTabId, 'docs')
  assert.deepEqual(sessions.get('sessionB')?.tabs.map(tab => tab.id), ['docs'])
})
