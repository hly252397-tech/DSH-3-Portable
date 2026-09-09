const { createHash } = require('node:crypto')
const { writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')
const { app } = require('electron')
const { createReadStream } = require('original-fs')

const archive = process.argv.find(value => /\.asar$/i.test(value))
const expected = process.argv.find(value => /^[a-f0-9]{64}$/i.test(value))?.toLowerCase()
const report = process.env.DSH_ASAR_SMOKE_REPORT

async function main() {
  if (!archive || !/^[a-f0-9]{64}$/i.test(expected ?? '')) {
    if (report) writeFileSync(report, JSON.stringify({ ok: false, error: 'invalid arguments', argv: process.argv }))
    return 2
  }
  await app.whenReady()
  try {
    const updater = await import(pathToFileURL(resolve(process.cwd(), 'dist/src/portable-desktop-update.js')).href)
    if (!await updater.physicalFileIsRegular(archive)) throw new Error('physical app.asar was not recognized as a regular file')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    const actual = hash.digest('hex')
    if (actual !== expected) throw new Error(`app.asar SHA256 mismatch: ${actual}`)
    if (report) writeFileSync(report, JSON.stringify({ ok: true, archive, isRegularFile: true, sha256: actual, verifiedWith: 'electron-original-fs' }))
    return 0
  } catch (error) {
    if (report) writeFileSync(report, JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) }))
    return 1
  }
}

main().then(code => app.exit(code), error => {
  if (report) writeFileSync(report, JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) }))
  app.exit(1)
})
