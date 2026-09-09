(() => {
  'use strict'

  // Offline point-cloud mark for the startup surface. Geometry is sampled once
  // from the packaged transparent whale; animation never depends on the network.

  const canvas = document.getElementById('whaleParticles')
  const mark = document.getElementById('whaleMark')
  const fallback = document.getElementById('whaleFallback')
  const progressIndicator = document.getElementById('startupProgress')
  if (!(canvas instanceof HTMLCanvasElement) || !(fallback instanceof HTMLImageElement)) return

  const context = canvas.getContext('2d', { alpha: true })
  if (!context) return

  const colorProbe = document.createElement('canvas').getContext('2d')
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const particles = []
  const particleLayers = [[], [], [], []]
  const ambientParticles = []
  const glowParticles = []
  const motion = {}
  const frameInterval = 1000 / 30
  const maximumPixelRatio = 2.25
  const maximumBackingPixels = 720000
  const maskSize = 256
  const bodyGap = 5.5
  let palette = null
  let cssWidth = 236
  let cssHeight = 176
  let pixelRatio = 1
  let frame = 0
  let startedAt = 0
  let lastPaintedAt = -Infinity
  let progressRatio = null
  let initialised = false
  let triedDevelopmentSource = false
  let disposed = false

  function seeded(index, salt) {
    const value = Math.sin(index * 78.233 + salt * 37.719) * 43758.5453
    return value - Math.floor(value)
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value))
  }

  function mix(first, second, amount) {
    return first.map((value, index) => Math.round(value + (second[index] - value) * amount))
  }

  function parseColor(value, fallbackColor) {
    if (!colorProbe) return fallbackColor
    const candidate = value.trim()
    if (!candidate) return fallbackColor
    colorProbe.fillStyle = '#000000'
    colorProbe.fillStyle = candidate
    const normalized = colorProbe.fillStyle
    const hex = normalized.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
    if (hex) return hex.slice(1).map(channel => parseInt(channel, 16))
    const rgb = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
    return rgb ? rgb.slice(1).map(Number) : fallbackColor
  }

  function rgba(color, opacity) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${opacity})`
  }

  function refreshPalette() {
    const rootStyle = getComputedStyle(document.documentElement)
    const light = document.documentElement.dataset.colorScheme === 'light'
    const text = parseColor(rootStyle.getPropertyValue('--dsh-text-primary'), light ? [17, 24, 28] : [241, 246, 248])
    const accentToken = rootStyle.getPropertyValue('--accent') || rootStyle.getPropertyValue('--dsh-accent')
    const accent = parseColor(accentToken, light ? [23, 111, 209] : [85, 167, 255])
    const background = parseColor(rootStyle.getPropertyValue('--dsh-bg-canvas'), light ? [244, 248, 250] : [15, 19, 22])
    const far = mix(text, background, light ? .62 : .72)
    const shade = mix(text, accent, light ? .08 : .12)
    const body = mix(text, accent, light ? .2 : .18)
    const key = mix(text, accent, light ? .4 : .3)
    palette = {
      light,
      layers: [far, shade, body, key],
      opacities: [light ? .38 : .32, light ? .56 : .52, light ? .72 : .72, light ? .86 : .9],
      accent: mix(accent, text, light ? .1 : .24),
      glow: accent,
    }
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect()
    cssWidth = Math.max(1, bounds.width || 236)
    cssHeight = Math.max(1, bounds.height || 176)
    const requestedRatio = Math.max(1, window.devicePixelRatio || 1)
    const safeRatio = Math.sqrt(maximumBackingPixels / (cssWidth * cssHeight))
    pixelRatio = Math.min(requestedRatio, maximumPixelRatio, safeRatio)
    const width = Math.max(1, Math.round(cssWidth * pixelRatio))
    const height = Math.max(1, Math.round(cssHeight * pixelRatio))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    if (reducedMotion.matches && particles.length) paint(startedAt + 1600)
  }

  function buildParticles() {
    const mask = document.createElement('canvas')
    mask.width = maskSize
    mask.height = maskSize
    const maskContext = mask.getContext('2d', { willReadFrequently: true })
    if (!maskContext) return false

    let pixels
    try {
      maskContext.clearRect(0, 0, maskSize, maskSize)
      maskContext.drawImage(fallback, 0, 0, maskSize, maskSize)
      pixels = maskContext.getImageData(0, 0, maskSize, maskSize).data
    } catch {
      return false
    }
    const alphaAt = (x, y) => {
      const safeX = clamp(Math.round(x), 0, maskSize - 1)
      const safeY = clamp(Math.round(y), 0, maskSize - 1)
      return pixels[(safeY * maskSize + safeX) * 4 + 3]
    }

    let minX = maskSize
    let minY = maskSize
    let maxX = 0
    let maxY = 0
    for (let y = 0; y < maskSize; y += 2) {
      for (let x = 0; x < maskSize; x += 2) {
        if (alphaAt(x, y) < 32) continue
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    if (maxX <= minX || maxY <= minY) return false

    particles.length = 0
    particleLayers.forEach(layer => { layer.length = 0 })
    ambientParticles.length = 0
    glowParticles.length = 0
    let index = 0
    for (let y = minY; y <= maxY; y += bodyGap) {
      const row = Math.round((y - minY) / bodyGap)
      for (let x = minX + (row % 2) * bodyGap * .5; x <= maxX; x += bodyGap) {
        const jitterX = (seeded(index, 1) - .5) * bodyGap * .5
        const jitterY = (seeded(index, 2) - .5) * bodyGap * .5
        const sampleX = x + jitterX
        const sampleY = y + jitterY
        const alpha = alphaAt(sampleX, sampleY)
        index += 1
        if (alpha < 88) continue

        const edgeDistance = 4
        const edge = alphaAt(sampleX - edgeDistance, sampleY) < 72 ||
          alphaAt(sampleX + edgeDistance, sampleY) < 72 ||
          alphaAt(sampleX, sampleY - edgeDistance) < 72 ||
          alphaAt(sampleX, sampleY + edgeDistance) < 72
        const nx = (sampleX - minX) / Math.max(1, maxX - minX)
        const ny = (sampleY - minY) / Math.max(1, maxY - minY)
        const depth = seeded(index, 3)
        const lightScore = clamp((1 - ny) * .5 + (1 - nx) * .25 + depth * .25 + (edge ? .1 : 0), 0, 1)
        const bucket = lightScore < .36 ? 0 : lightScore < .56 ? 1 : lightScore < .74 ? 2 : 3
        const waveAngle = nx * 4.8
        const shimmerAngle = seeded(index, 4) * Math.PI * 2
        const tail = Math.pow(clamp((nx - .62) / .38, 0, 1), 1.7)
        const facet = (bucket >= 2 || edge) && seeded(index, 8) > .72
        const particle = {
          nx,
          ny,
          depth,
          bucket,
          edge,
          facet,
          facetShear: (seeded(index, 9) - .5) * .34,
          radius: (edge ? .94 : .68) + depth * .78,
          waveSin: Math.sin(waveAngle),
          waveCos: Math.cos(waveAngle),
          shimmerSin: Math.sin(shimmerAngle),
          shimmerCos: Math.cos(shimmerAngle),
          tail,
          arrivalDelay: (edge ? 92 : 18) + seeded(index, 10) * (edge ? 116 : 74),
          entryX: (nx - .5) * 38 + (seeded(index, 5) - .5) * 15,
          entryY: (ny - .5) * 29 + (seeded(index, 6) - .5) * 12,
          glow: edge && seeded(index, 7) > .62,
          x: 0,
          y: 0,
          drawRadius: 0,
        }
        particles.push(particle)
        particleLayers[bucket].push(particle)
        if (seeded(index, 11) > .66) ambientParticles.push(particle)
        if (particle.glow) glowParticles.push(particle)
      }
    }
    return particles.length > 120
  }

  function updateMotion(elapsed) {
    motion.drawWidth = cssWidth * .91
    motion.drawHeight = motion.drawWidth * .752
    motion.left = (cssWidth - motion.drawWidth) * .5
    motion.top = (cssHeight - motion.drawHeight) * .5 - 1
    motion.centerX = motion.left + motion.drawWidth * .5
    motion.centerY = motion.top + motion.drawHeight * .52
    motion.scale = clamp(motion.drawWidth / (236 * .91), .92, 1.18)
    const calm = reducedMotion.matches
    motion.yaw = calm ? 0 : Math.sin(elapsed * .00037) * .06
    motion.roll = calm ? 0 : Math.sin(elapsed * .00029 + .8) * .012
    motion.floatY = calm ? 0 : Math.sin(elapsed * .00068) * .92
    motion.cosine = Math.cos(motion.roll)
    motion.sine = Math.sin(motion.roll)
    const swimClock = elapsed * .00086
    const shimmerClock = elapsed * .00117
    motion.swimSin = calm ? 0 : Math.sin(swimClock)
    motion.swimCos = calm ? 1 : Math.cos(swimClock)
    motion.shimmerSin = calm ? 0 : Math.sin(shimmerClock)
    motion.shimmerCos = calm ? 1 : Math.cos(shimmerClock)
    motion.breathe = calm ? 0 : Math.sin(elapsed * .00058 + .45)
    motion.calm = calm
  }

  function updateParticlePosition(particle, elapsed) {
    const arrival = motion.calm ? 1 : clamp((elapsed - particle.arrivalDelay) / 780, 0, 1)
    const formation = motion.calm ? 1 : 1 - Math.pow(1 - arrival, 4)
    const depthShift = (particle.depth - .5) * motion.yaw * 34 * motion.scale
    const localX = motion.left + particle.nx * motion.drawWidth - motion.centerX
    const localY = motion.top + particle.ny * motion.drawHeight - motion.centerY
    const coherentWave = motion.swimSin * particle.waveCos + motion.swimCos * particle.waveSin
    const tailLift = coherentWave * (.1 + particle.tail * 2.3) * motion.scale
    const tailDrift = motion.swimCos * particle.tail * .58 * motion.scale
    const breathing = (particle.ny - .5) * motion.breathe * .72 * motion.scale
    const shimmer = motion.shimmerSin * particle.shimmerCos + motion.shimmerCos * particle.shimmerSin
    particle.x = motion.centerX + localX * motion.cosine - localY * motion.sine + depthShift + tailDrift + particle.entryX * (1 - formation)
    particle.y = motion.centerY + localX * motion.sine + localY * motion.cosine + motion.floatY + tailLift + breathing + particle.entryY * (1 - formation)
    particle.drawRadius = particle.radius * motion.scale * (.92 + particle.depth * .12) * (.7 + formation * .3) * (1 + shimmer * (particle.edge ? .026 : .01))
  }

  function addParticleShape(particle, radiusScale = 1) {
    const radius = particle.drawRadius * radiusScale
    if (!particle.facet) {
      context.moveTo(particle.x + radius, particle.y)
      context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
      return
    }
    const shear = particle.facetShear * radius
    context.moveTo(particle.x + shear, particle.y - radius)
    context.lineTo(particle.x + radius * 1.08, particle.y + shear)
    context.lineTo(particle.x - shear, particle.y + radius)
    context.lineTo(particle.x - radius * 1.08, particle.y - shear)
    context.closePath()
  }

  function paint(timestamp) {
    if (!palette || !particles.length) return
    const elapsed = Math.max(0, timestamp - startedAt)
    const formation = reducedMotion.matches ? 1 : 1 - Math.pow(1 - clamp(elapsed / 980, 0, 1), 4)
    const sweep = progressRatio === null
      ? (reducedMotion.matches ? .7 : ((elapsed / 6200) % 1.34) - .17)
      : .05 + progressRatio * .9
    updateMotion(elapsed)
    for (const particle of particles) updateParticlePosition(particle, elapsed)

    context.clearRect(0, 0, cssWidth, cssHeight)
    context.globalCompositeOperation = palette.light ? 'source-over' : 'lighter'

    context.save()
    context.beginPath()
    for (const particle of ambientParticles) addParticleShape(particle, 1.42)
    context.fillStyle = rgba(palette.glow, (palette.light ? .045 : .075) * formation)
    context.shadowColor = rgba(palette.glow, palette.light ? .12 : .24)
    context.shadowBlur = palette.light ? 6 : 9
    context.fill()
    context.restore()

    for (let bucket = 0; bucket < particleLayers.length; bucket += 1) {
      context.beginPath()
      for (const particle of particleLayers[bucket]) addParticleShape(particle)
      context.fillStyle = rgba(palette.layers[bucket], palette.opacities[bucket] * (.3 + formation * .7))
      context.fill()
    }

    context.save()
    context.beginPath()
    for (const particle of glowParticles) {
      if (Math.abs(particle.nx - sweep) > .052) continue
      const intensity = 1 - Math.abs(particle.nx - sweep) / .052
      addParticleShape(particle, 1.14 + intensity * .54)
    }
    context.fillStyle = rgba(palette.accent, palette.light ? .58 : .72)
    context.shadowColor = rgba(palette.glow, palette.light ? .28 : .54)
    context.shadowBlur = palette.light ? 4 : 8
    context.fill()
    context.restore()

    context.globalCompositeOperation = 'source-over'
    if (mark && mark.dataset.rendered !== 'true') mark.dataset.rendered = 'true'
  }

  function tick(timestamp) {
    if (disposed || document.hidden || reducedMotion.matches) return
    frame = requestAnimationFrame(tick)
    if (!Number.isFinite(lastPaintedAt)) lastPaintedAt = timestamp - frameInterval
    const delta = timestamp - lastPaintedAt
    if (delta < frameInterval) return
    lastPaintedAt = timestamp - (delta % frameInterval)
    paint(timestamp)
  }

  function startTimeline() {
    cancelAnimationFrame(frame)
    startedAt = performance.now()
    lastPaintedAt = -Infinity
    if (reducedMotion.matches) {
      paint(startedAt + 1600)
      return
    }
    frame = requestAnimationFrame(tick)
  }

  function handleVisibility() {
    cancelAnimationFrame(frame)
    if (!document.hidden && !reducedMotion.matches && !disposed) {
      lastPaintedAt = -Infinity
      frame = requestAnimationFrame(tick)
    }
  }

  function handleMotionPreference() {
    startTimeline()
  }

  function handleThemeChange() {
    refreshPalette()
    if (reducedMotion.matches) paint(startedAt + 1600)
  }

  function handleProgressChange() {
    const value = Number(progressIndicator?.getAttribute('aria-valuenow'))
    progressRatio = progressIndicator?.hidden || !Number.isFinite(value) ? null : clamp(value / 100, 0, 1)
    if (reducedMotion.matches) paint(startedAt + 1600)
  }

  const themeObserver = new MutationObserver(handleThemeChange)
  const progressObserver = progressIndicator ? new MutationObserver(handleProgressChange) : null
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null

  function dispose() {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    themeObserver.disconnect()
    progressObserver?.disconnect()
    resizeObserver?.disconnect()
    reducedMotion.removeEventListener('change', handleMotionPreference)
    document.removeEventListener('visibilitychange', handleVisibility)
    window.removeEventListener('resize', resize)
    window.removeEventListener('dsh-theme-change', handleThemeChange)
    fallback.removeEventListener('error', handleFallbackError)
    fallback.removeEventListener('load', initialise)
  }

  function initialise() {
    if (disposed || initialised || !fallback.naturalWidth || !buildParticles()) return
    initialised = true
    fallback.removeEventListener('load', initialise)
    refreshPalette()
    resize()
    startTimeline()
  }

  function handleFallbackError() {
    if (triedDevelopmentSource) return
    triedDevelopmentSource = true
    fallback.src = './icons/taskbar.png'
  }

  reducedMotion.addEventListener('change', handleMotionPreference)
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('dsh-theme-change', handleThemeChange)
  window.addEventListener('pagehide', dispose, { once: true })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-color-scheme', 'data-dsh-preset', 'data-theme'],
  })
  if (progressIndicator && progressObserver) {
    handleProgressChange()
    progressObserver.observe(progressIndicator, { attributes: true, attributeFilter: ['aria-valuenow', 'hidden'] })
  }
  if (resizeObserver) resizeObserver.observe(canvas)
  else window.addEventListener('resize', resize)

  fallback.addEventListener('error', handleFallbackError)
  fallback.addEventListener('load', initialise, { once: true })
  if (fallback.complete) {
    if (fallback.naturalWidth) initialise()
    else handleFallbackError()
  }
})()
