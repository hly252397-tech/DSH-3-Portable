import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { resolveAppIconPath, resolveCompactIconCrop, resolveNotificationIconPath, resolveRasterIconPath, resolveTaskBadgeIconPath, resolveTaskbarIconPath, resolveTrayIconPath } from '../src/app-icon.js'

test('任务栏优先多尺寸光学图标，托盘保持原鲸鱼', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-optical-icon-'))
  try {
    await writeFile(join(root, 'taskbar-optical.ico'), 'optical')
    await writeFile(join(root, 'taskbar.png'), 'original')
    const options = {appPath: root, resourcesPath: root, isPackaged: true}
    assert.equal(resolveTaskbarIconPath(options), join(root, 'taskbar-optical.ico'))
    assert.equal(resolveTrayIconPath(options), join(root, 'taskbar.png'))
  } finally { await rm(root, {recursive: true, force: true}) }
})

test('光学 ICO 包含完整尺寸及透明 PNG 帧，并被打包', async () => {
  const ico = await readFile(resolve('assets/icons/taskbar-optical.ico'))
  const sizes = [16,20,24,32,40,48,64,256]
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), sizes.length)
  sizes.forEach((size,i) => {
    const p = 6+i*16
    assert.equal(ico[p] || 256, size)
    assert.equal(ico[p+1] || 256, size)
    const offset = ico.readUInt32LE(p+12)
    const length = ico.readUInt32LE(p+8)
    assert(offset + length <= ico.length)
    assert.equal(ico.subarray(offset,offset+8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(ico.readUInt32BE(offset+16), size)
    assert.equal(ico[offset+25], 6, 'RGBA PNG frame')
  })
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  assert(manifest.build.extraResources.some((r: {from: string, to: string}) => r.from==='assets/icons/taskbar-optical.ico' && r.to==='taskbar-optical.ico'))
})

test('打包态优先使用 extraResources 中的 ico', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-icon-'))
  try {
    await writeFile(join(root, 'icon.ico'), 'ico')
    await writeFile(join(root, 'icon.png'), 'png')
    assert.equal(resolveAppIconPath({ appPath: root, isPackaged: true, resourcesPath: root }), join(root, 'icon.ico'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('开发态使用仓库 assets 图标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-icon-dev-'))
  try {
    await mkdir(join(root, 'assets', 'icons'), { recursive: true })
    await writeFile(join(root, 'assets', 'icons', 'icon.ico'), 'ico')
    assert.equal(
      resolveAppIconPath({ appPath: root, isPackaged: false, resourcesPath: join(root, 'missing') }),
      join(root, 'assets', 'icons', 'icon.ico'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('托盘继续优先使用现有 PNG', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-icon-raster-'))
  try {
    await writeFile(join(root, 'icon.ico'), 'ico')
    await writeFile(join(root, 'icon.png'), 'png')
    assert.equal(resolveRasterIconPath({ appPath: root, isPackaged: true, resourcesPath: root }), join(root, 'icon.png'))
    assert.equal(resolveAppIconPath({ appPath: root, isPackaged: true, resourcesPath: root }), join(root, 'icon.ico'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('任务栏和托盘共用第一版专用鲸鱼', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-taskbar-icon-'))
  try {
    await writeFile(join(root, 'taskbar.png'), 'first-portable-whale')
    await writeFile(join(root, 'icon.png'), 'current-tray-icon')
    assert.equal(resolveTaskbarIconPath({ appPath: root, isPackaged: true, resourcesPath: root }), join(root, 'taskbar.png'))
    assert.equal(resolveTrayIconPath({ appPath: root, isPackaged: true, resourcesPath: root }), join(root, 'taskbar.png'))
    assert.equal(resolveRasterIconPath({ appPath: root, isPackaged: true, resourcesPath: root }), join(root, 'icon.png'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('缺少第一版专用鲸鱼时托盘安全回退现有图标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tray-icon-fallback-'))
  try {
    await writeFile(join(root, 'icon.png'), 'current-tray-icon')
    assert.equal(resolveTrayIconPath({ appPath: root, isPackaged: true, resourcesPath: root }), join(root, 'icon.png'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('托盘和任务栏裁掉应用图标的大部分透明边距，并保持居中正方形', () => {
  assert.deepEqual(resolveCompactIconCrop({ width: 512, height: 512 }), {
    x: 28,
    y: 28,
    width: 456,
    height: 456,
  })
  assert.deepEqual(resolveCompactIconCrop({ width: 600, height: 512 }), {
    x: 72,
    y: 28,
    width: 456,
    height: 456,
  })
})

test('任务栏未读标记按计数选择开发态和打包态资源', () => {
  assert.equal(
    resolveTaskBadgeIconPath({ appPath: 'D:\\app', isPackaged: false, resourcesPath: 'D:\\resources' }, 3),
    resolve('D:\\app', 'assets', 'task-badges', '3.png'),
  )
  assert.equal(
    resolveTaskBadgeIconPath({ appPath: 'D:\\app', isPackaged: true, resourcesPath: 'D:\\resources' }, 12),
    join('D:\\resources', 'task-badges', '9-plus.png'),
  )
})

test('Windows 通知来源使用紧凑图标资源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-notification-icon-'))
  try {
    await writeFile(join(root, 'notification.ico'), 'ico')
    assert.equal(resolveNotificationIconPath({ appPath: root, isPackaged: true, resourcesPath: root }), join(root, 'notification.ico'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
