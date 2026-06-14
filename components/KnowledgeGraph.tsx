'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { motion, AnimatePresence } from 'framer-motion'

// ============================================================
// Types — mirror public/data/graph.json (scripts/build_graph.py)
// ============================================================

interface RawNode {
  id: string
  title: string
  type: string
  domain: string[]
  tags: string[]
  judgment: string
  confidence: string
  updated: string
  summary: string
  degree: number
  ghost: boolean
  private: boolean
  en: string
  featured: boolean
}

interface RawLink {
  source: string
  target: string
  weight: number
  kinds: string[]
}

interface GNode extends d3.SimulationNodeDatum {
  id: string
  title: string
  type: string
  domain: string[]
  tags: string[]
  judgment: string
  confidence: string
  updated: string
  summary: string
  degree: number
  ghost: boolean
  private: boolean
  en: string
  featured: boolean
  radius: number
  cluster: number
  tone: string
  isCenter: boolean
  phase: number
}

interface GLink {
  source: string | GNode
  target: string | GNode
  weight: number
  kinds: string[]
  primaryKind: string
}

interface ClusterInfo {
  id: number
  name: string
  tone: string
  count: number
}

interface Graph {
  nodes: GNode[]
  links: GLink[]
  clusters: ClusterInfo[]
  adjacency: Map<string, Set<string>>
  nodeById: Map<string, GNode>
}

// ============================================================
// Aesthetic — monochrome base, muted Morandi cluster tones
// ============================================================

const CENTER_TITLE = '常天喆'
const BONE = '#ECEAE3' // off-white core
const INK = '#06060A' // near-black backdrop

// Elegant serif stack — literary, gallery-grade; matches Chang's background.
const FONT_CJK =
  '"Songti SC", "STSong", "Source Han Serif SC", "Noto Serif SC", "Source Han Serif CN", serif'
const FONT_EN = '"Optima", "Cormorant Garamond", "Songti SC", Georgia, "Times New Roman", serif'

const TYPE_LABELS: Record<string, string> = {
  entity: '人物',
  concept: '概念',
  source: '来源',
  'source-summary': '来源',
  timeline: '时间',
}

const KIND_LABELS: Record<string, string> = {
  related: '关联',
  link: '引用',
  source: '出处',
  tag: '同源',
}

const KIND_PRIORITY = ['related', 'source', 'link', 'tag']

// Morandi: low-saturation, dusty, grayed tones. On near-black they read as
// tinted bone rather than colour — distinguishable, never neon.
const MORANDI = [
  '#AEB4A6', // sage
  '#C2A9A2', // clay rose
  '#9DAAB6', // dusty slate blue
  '#B2A6B0', // mauve grey
  '#BFB5A4', // warm taupe
  '#A7AE9A', // olive grey
  '#9EB1AB', // dusty teal
  '#B8AEA2', // stone
  '#ADA8B2', // lavender ash
  '#C4B6AC', // sand
  '#A4ABAE', // cool grey
  '#B6AFA0', // linen
]
const MISC_TONE = '#8A8A86'

// ============================================================
// Data pipeline
// ============================================================

function buildGraph(data: { nodes: RawNode[]; links: RawLink[] }): Graph {
  const nodes: GNode[] = data.nodes.map((n) => ({
    ...n,
    radius: 3,
    cluster: -1,
    tone: MISC_TONE,
    isCenter: n.title === CENTER_TITLE,
    phase: Math.random() * Math.PI * 2,
  }))

  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const links: GLink[] = data.links
    .filter((l) => nodeById.has(l.source) && nodeById.has(l.target))
    .map((l) => ({
      source: l.source,
      target: l.target,
      weight: l.weight,
      kinds: l.kinds,
      primaryKind: KIND_PRIORITY.find((k) => l.kinds.includes(k)) || 'link',
    }))

  const adjacency = new Map<string, Set<string>>()
  const wAdj = new Map<string, Array<[string, number]>>()
  nodes.forEach((n) => {
    adjacency.set(n.id, new Set())
    wAdj.set(n.id, [])
  })
  links.forEach((l) => {
    const s = l.source as string
    const t = l.target as string
    adjacency.get(s)!.add(t)
    adjacency.get(t)!.add(s)
    wAdj.get(s)!.push([t, l.weight])
    wAdj.get(t)!.push([s, l.weight])
  })

  // ---- community detection: weighted label propagation ----
  const isNeutral = (n: GNode) =>
    n.isCenter || n.type === 'source' || n.type === 'source-summary' || n.type === 'timeline'

  const labels = new Map<string, number>()
  nodes.forEach((n, i) => labels.set(n.id, i))
  const voters = nodes.filter((n) => !isNeutral(n)).sort((a, b) => b.degree - a.degree)

  for (let iter = 0; iter < 24; iter++) {
    let changed = 0
    for (const n of voters) {
      const tally = new Map<number, number>()
      for (const [nb, w] of wAdj.get(n.id)!) {
        if (isNeutral(nodeById.get(nb)!)) continue
        const l = labels.get(nb)!
        tally.set(l, (tally.get(l) || 0) + w)
      }
      if (tally.size === 0) continue
      let best = labels.get(n.id)!
      let bestW = -1
      tally.forEach((w, l) => {
        if (w > bestW || (w === bestW && l === labels.get(n.id))) {
          bestW = w
          best = l
        }
      })
      if (best !== labels.get(n.id)) {
        labels.set(n.id, best)
        changed++
      }
    }
    if (changed === 0) break
  }
  nodes.forEach((n) => {
    if (!isNeutral(n)) return
    const tally = new Map<number, number>()
    for (const [nb, w] of wAdj.get(n.id)!) {
      if (isNeutral(nodeById.get(nb)!)) continue
      const l = labels.get(nb)!
      tally.set(l, (tally.get(l) || 0) + w)
    }
    let best = -1
    let bestW = -1
    tally.forEach((w, l) => {
      if (w > bestW) {
        bestW = w
        best = l
      }
    })
    if (best >= 0) labels.set(n.id, best)
  })

  const members = new Map<number, GNode[]>()
  nodes.forEach((n) => {
    const l = labels.get(n.id)!
    if (!members.has(l)) members.set(l, [])
    members.get(l)!.push(n)
  })
  const ranked = Array.from(members.entries()).sort((a, b) => b[1].length - a[1].length)

  const clusters: ClusterInfo[] = []
  ranked.forEach(([, mem], idx) => {
    const usePalette = idx < MORANDI.length && mem.length >= 3
    const tone = usePalette ? MORANDI[idx] : MISC_TONE
    const sorted = mem.filter((m) => !m.isCenter).sort((a, b) => b.degree - a.degree)
    const hub =
      sorted.find((m) => m.type === 'entity' && m.title.length <= 10) ||
      sorted.find((m) => !m.private && m.title.length <= 12) ||
      sorted[0]
    if (usePalette) {
      clusters.push({ id: idx, name: hub ? hub.title : `簇 ${idx + 1}`, tone, count: mem.length })
    }
    mem.forEach((m) => {
      m.cluster = idx
      m.tone = usePalette ? tone : MISC_TONE
    })
  })

  nodes.forEach((n) => {
    const base = n.ghost ? 2.4 : n.type === 'timeline' ? 4 : 2.8
    n.radius = Math.min(13, base + Math.sqrt(n.degree) * 1.05)
    if (n.isCenter) {
      n.radius = 15
      n.tone = BONE
    }
  })

  return { nodes, links, clusters, adjacency, nodeById }
}

// soft round dot sprite (single, tinted at draw time via globalAlpha)
const haloCache = new Map<string, HTMLCanvasElement>()
function halo(color: string): HTMLCanvasElement {
  let c = haloCache.get(color)
  if (c) return c
  c = document.createElement('canvas')
  c.width = 48
  c.height = 48
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(24, 24, 0, 24, 24, 24)
  g.addColorStop(0, color + 'cc')
  g.addColorStop(0.4, color + '40')
  g.addColorStop(1, color + '00')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 48, 48)
  haloCache.set(color, c)
  return c
}

// ============================================================
// Component
// ============================================================

export default function KnowledgeGraph() {
  const mainRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const [graph, setGraph] = useState<Graph | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<GNode | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)

  const graphRef = useRef<Graph | null>(null)
  const transformRef = useRef(d3.zoomIdentity)
  const hoverRef = useRef<GNode | null>(null)
  const selectedRef = useRef<GNode | null>(null)
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const fitRef = useRef(0.8)
  // d3-transition's zoom interpolation is unreliable here, so we drive smooth
  // zoom ourselves via d3.timer + immediate transform application.
  const animateToRef = useRef<((t: d3.ZoomTransform, dur?: number) => void) | null>(null)

  selectedRef.current = selected

  // ---------- load ----------
  useEffect(() => {
    fetch('/data/graph.json')
      .then((r) => r.json())
      .then((data) => {
        const g = buildGraph(data)
        graphRef.current = g
        setGraph(g)
        setLoading(false)
      })
      .catch((e) => {
        console.error('Failed to load graph data:', e)
        setLoading(false)
      })
  }, [])

  // ---------- search ----------
  const searchResults = useMemo(() => {
    if (!graph || !query.trim()) return []
    const q = query.trim().toLowerCase()
    return graph.nodes
      .filter((n) => n.title.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 8)
  }, [graph, query])

  // Clicking a node "opens its constellation": frame the node together with
  // its direct neighbours, offset left so the detail panel doesn't cover them.
  const flyTo = (node: GNode) => {
    const g = graphRef.current
    if (node.x == null || node.y == null || !g || !animateToRef.current) return
    const pts: Array<[number, number]> = [[node.x, node.y]]
    g.adjacency.get(node.id)?.forEach((id) => {
      const m = g.nodeById.get(id)
      if (m && m.x != null && m.y != null) pts.push([m.x, m.y])
    })
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [px, py] of pts) {
      minX = Math.min(minX, px); maxX = Math.max(maxX, px)
      minY = Math.min(minY, py); maxY = Math.max(maxY, py)
    }
    const { w, h } = sizeRef.current
    const panel = w > 640 ? 360 : 0 // detail panel reserves right space
    const availW = w - panel
    const pad = 90
    const gw = (maxX - minX) + pad * 2
    const gh = (maxY - minY) + pad * 2
    const scale = Math.max(0.5, Math.min(3.2, Math.min(availW / gw, h / gh)))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const t = d3.zoomIdentity.translate(availW / 2, h / 2).scale(scale).translate(-cx, -cy)
    animateToRef.current(t, 850)
  }

  const selectNode = (node: GNode) => {
    setSelected(node)
    flyTo(node)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null)
        setSearchOpen(false)
        setQuery('')
      } else if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---------- canvas ----------
  useEffect(() => {
    if (!graph || !mainRef.current) return
    const canvas = mainRef.current
    const ctx = canvas.getContext('2d')!

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(window.innerWidth, 320)
      const h = Math.max(window.innerHeight, 400)
      sizeRef.current = { w, h, dpr }
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    resize()

    // faint static dust — texture, not a starfield
    const dust = Array.from({ length: 90 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 0.9 + 0.2,
      a: Math.random() * 0.06 + 0.015,
    }))

    const { nodes, links, nodeById, adjacency } = graph
    const center = nodes.find((n) => n.isCenter)
    if (center) {
      center.fx = 0
      center.fy = 0
    }

    // dense layout — tight colonies, short links, weak repulsion
    const simulation = d3
      .forceSimulation<GNode>(nodes)
      .velocityDecay(0.35)
      .force(
        'link',
        d3
          .forceLink<GNode, any>(links as any)
          .id((d: any) => d.id)
          .distance((l: any) => (l.primaryKind === 'tag' ? 80 : 52) - Math.min(l.weight, 4) * 4)
          .strength((l: any) => Math.min(0.95, (l.primaryKind === 'tag' ? 0.14 : 0.42) + l.weight * 0.08))
      )
      .force('charge', d3.forceManyBody<GNode>().strength((d) => (d.isCenter ? -1100 : -80 - d.radius * 16)).distanceMax(700))
      .force('x', d3.forceX(0).strength(0.03))
      .force('y', d3.forceY(0).strength(0.035))
      .force('collide', d3.forceCollide<GNode>().radius((d) => d.radius + 2.2).strength(1))
      .alpha(1)
      .alphaDecay(0.018)

    const findNode = (sx: number, sy: number): GNode | undefined => {
      const t = transformRef.current
      const [x, y] = t.invert([sx, sy])
      return simulation.find(x, y, Math.max(14 / t.k, 9))
    }

    const fitView = (dur = 700) => {
      const xs: number[] = []
      const ys: number[] = []
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue
        xs.push(n.x)
        ys.push(n.y)
      }
      if (xs.length === 0) return
      xs.sort((a, b) => a - b)
      ys.sort((a, b) => a - b)
      // percentile box ignores a few far-flung outliers that would otherwise
      // blow up the bounds and shrink the whole field
      const q = (arr: number[], p: number) => arr[Math.floor((arr.length - 1) * p)]
      const minX = q(xs, 0.03), maxX = q(xs, 0.97)
      const minY = q(ys, 0.03), maxY = q(ys, 0.97)
      const { w, h } = sizeRef.current
      const gw = maxX - minX || 1
      const gh = maxY - minY || 1
      const scale = Math.min(1.7, 0.8 * Math.min(w / gw, h / gh))
      fitRef.current = scale
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const t = d3.zoomIdentity.translate(w / 2, h / 2).scale(scale).translate(-cx, -cy)
      animateTo(t, dur)
    }

    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.2, 8])
      .filter((event: any) => {
        if (event.type === 'mousedown' || event.type === 'touchstart') {
          const [sx, sy] = d3.pointer(event, canvas)
          if (findNode(sx, sy)) return false
        }
        return !event.button
      })
      .on('zoom', (event) => {
        transformRef.current = event.transform
      })
    zoomRef.current = zoom
    const sel = d3.select(canvas)
    sel.call(zoom as any)

    // Smooth zoom driven by the existing rAF draw loop. d3.timer and
    // d3-transition's zoom interpolation both misfire in this canvas/preview
    // context, but immediate `sel.call(zoom.transform)` is reliable — so we
    // step the interpolation ourselves each frame.
    let zoomAnim: { start: d3.ZoomTransform; target: d3.ZoomTransform; t0: number; dur: number } | null = null
    const animateTo = (target: d3.ZoomTransform, dur = 800) => {
      if (dur <= 0) {
        sel.call(zoom.transform as any, target)
        return
      }
      zoomAnim = { start: transformRef.current, target, t0: performance.now(), dur }
    }
    const stepZoom = (time: number) => {
      if (!zoomAnim) return
      const { start, target, t0, dur } = zoomAnim
      const u = Math.min(1, (time - t0) / dur)
      const e = d3.easeCubicInOut(u)
      const k = start.k + (target.k - start.k) * e
      const x = start.x + (target.x - start.x) * e
      const y = start.y + (target.y - start.y) * e
      sel.call(zoom.transform as any, d3.zoomIdentity.translate(x, y).scale(k))
      if (u >= 1) zoomAnim = null
    }
    animateToRef.current = animateTo

    // opening: start framed out, let the mass condense, then ease to a precise
    // fit. Settle detection via tick event, with a timed fallback.
    const { w, h } = sizeRef.current
    sel.call(zoom.transform as any, d3.zoomIdentity.translate(w / 2, h / 2).scale(0.45))
    let fitted = false
    const doFit = (dur: number) => {
      if (fitted) return
      fitted = true
      fitView(dur)
      simulation.on('tick.fit', null)
    }
    simulation.on('tick.fit', () => {
      if (simulation.alpha() < 0.12) doFit(700)
    })
    const fitFallback = setTimeout(() => doFit(700), 3200)

    const drag = d3
      .drag<HTMLCanvasElement, unknown>()
      .subject((event: any) => {
        const [sx, sy] = d3.pointer(event, canvas)
        const n = findNode(sx, sy)
        return n && !n.isCenter ? n : (null as any)
      })
      .on('start', (event: any) => {
        if (!event.active) simulation.alphaTarget(0.2).restart()
        const t = transformRef.current
        event.subject.fx = t.invertX(event.x)
        event.subject.fy = t.invertY(event.y)
      })
      .on('drag', (event: any) => {
        const t = transformRef.current
        event.subject.fx = t.invertX(event.x)
        event.subject.fy = t.invertY(event.y)
      })
      .on('end', (event: any) => {
        if (!event.active) simulation.alphaTarget(0)
        event.subject.fx = null
        event.subject.fy = null
      })
    sel.call(drag as any)

    let moved = false
    const onMove = (e: MouseEvent) => {
      const [sx, sy] = d3.pointer(e, canvas)
      const n = findNode(sx, sy)
      hoverRef.current = n || null
      canvas.style.cursor = n ? 'pointer' : 'grab'
    }
    const onDown = () => (moved = false)
    const onMoveTrack = () => (moved = true)
    const onClick = (e: MouseEvent) => {
      if (moved) return
      const [sx, sy] = d3.pointer(e, canvas)
      const n = findNode(sx, sy)
      if (n) setSelected(n)
      else setSelected(null)
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onMoveTrack)
    canvas.addEventListener('click', onClick)

    let raf = 0
    const draw = (time: number) => {
      stepZoom(time)
      const { w, h, dpr } = sizeRef.current
      const t = transformRef.current
      const focus = hoverRef.current || selectedRef.current
      const neighbors = focus ? adjacency.get(focus.id) : null

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // dust
      ctx.fillStyle = '#ffffff'
      for (const d of dust) {
        ctx.globalAlpha = d.a
        ctx.beginPath()
        ctx.arc(d.x * w, d.y * h, d.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1

      ctx.translate(t.x, t.y)
      ctx.scale(t.k, t.k)

      const drift = (n: GNode, ax: boolean) =>
        (ax ? n.x! : n.y!) + (ax ? Math.sin(time * 0.0004 + n.phase) : Math.cos(time * 0.00035 + n.phase * 1.2)) * 0.8
      const ox = (n: GNode) => drift(n, true)
      const oy = (n: GNode) => drift(n, false)

      // ---- edges: straight hairlines ----
      ctx.lineCap = 'round'
      for (const l of links) {
        const s = l.source as GNode
        const tg = l.target as GNode
        if (s.x == null || tg.x == null) continue
        const isTag = l.primaryKind === 'tag'

        let alpha = (isTag ? 0.05 : 0.1) + Math.min(l.weight, 5) * 0.018
        let width = (l.primaryKind === 'related' ? 0.55 : 0.4) / 1
        let color = '255,255,255'

        if (focus) {
          const touches = s.id === focus.id || tg.id === focus.id
          if (touches) {
            alpha = 0.55
            width = 0.9
            const c = hexToRgb(focus.tone)
            color = `${c.r},${c.g},${c.b}`
          } else {
            alpha *= 0.18
          }
        }
        ctx.globalAlpha = alpha
        ctx.strokeStyle = `rgba(${color},1)`
        ctx.lineWidth = width
        ctx.beginPath()
        ctx.moveTo(ox(s), oy(s))
        ctx.lineTo(ox(tg), oy(tg))
        ctx.stroke()
      }

      // ---- nodes ----
      for (const n of nodes) {
        if (n.x == null) continue
        let alpha = 1
        if (focus && focus.id !== n.id && !neighbors?.has(n.id)) alpha *= 0.16
        const x = ox(n), y = oy(n)
        const isFocus = focus?.id === n.id

        // soft halo for center / focus only — keeps the field crisp
        if (n.isCenter || isFocus) {
          const sprite = halo(n.isCenter ? BONE : n.tone)
          const r = n.radius * (n.isCenter ? 4.5 + Math.sin(time / 600) * 0.4 : 4)
          ctx.globalAlpha = alpha * (n.isCenter ? 0.5 : 0.4)
          ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2)
        }

        ctx.globalAlpha = alpha
        if (n.ghost) {
          ctx.beginPath()
          ctx.arc(x, y, n.radius, 0, Math.PI * 2)
          ctx.fillStyle = INK
          ctx.fill()
          ctx.lineWidth = 0.9
          ctx.strokeStyle = n.tone
          ctx.globalAlpha = alpha * 0.85
          ctx.stroke()
        } else {
          ctx.beginPath()
          ctx.arc(x, y, n.radius * (isFocus ? 1.2 : 1), 0, Math.PI * 2)
          ctx.fillStyle = n.tone
          ctx.fill()
          if (n.isCenter || n.radius > 6) {
            ctx.globalAlpha = alpha * 0.95
            ctx.fillStyle = BONE
            ctx.beginPath()
            ctx.arc(x, y, Math.max(1, n.radius * 0.42), 0, Math.PI * 2)
            ctx.fill()
          }
        }

        if (selectedRef.current?.id === n.id) {
          ctx.globalAlpha = 0.75
          ctx.strokeStyle = BONE
          ctx.lineWidth = 1.2 / t.k
          ctx.beginPath()
          ctx.arc(x, y, n.radius + 5 / t.k, 0, Math.PI * 2)
          ctx.stroke()
          ctx.globalAlpha = 0.2
          ctx.lineWidth = 0.8 / t.k
          ctx.beginPath()
          ctx.arc(x, y, n.radius + 14 / t.k, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // ---- labels: collision-aware ----
      // draw in SCREEN space (constant size, easy collision boxes)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const k = t.k
      // drawn label boxes in SCREEN space, to suppress overlaps
      const boxes: Array<[number, number, number, number]> = []
      const fits = (cx: number, cy: number, half: number, hh: number) => {
        const x0 = cx - half, x1 = cx + half, y0 = cy - hh, y1 = cy + hh
        for (const [bx0, by0, bx1, by1] of boxes) {
          if (x0 < bx1 && x1 > bx0 && y0 < by1 && y1 > by0) return false
        }
        boxes.push([x0, y0, x1, y1])
        return true
      }

      const drawLabel = (
        n: GNode, text: string, opts: { dim?: number; weight?: number; size?: number }
      ) => {
        const sx = (ox(n)) * k + t.x
        const sy = (oy(n)) * k + t.y
        if (sx < -50 || sx > w + 50 || sy < -30 || sy > h + 30) return
        const fs = opts.size ?? 12
        const yOff = n.radius * k + 5
        ctx.font = `${opts.weight ?? 400} ${fs}px ${FONT_CJK}`
        const wpx = ctx.measureText(text).width
        const labY = sy + yOff + fs / 2
        if (!fits(sx, labY, wpx / 2 + 4, fs / 2 + 3)) return
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.globalAlpha = opts.dim ?? 1
        ctx.shadowColor = 'rgba(0,0,0,0.92)'
        ctx.shadowBlur = 5
        ctx.fillStyle = opts.weight && opts.weight >= 500 ? BONE : '#b9b6ad'
        ctx.fillText(text, sx, labY)
        ctx.shadowBlur = 0
      }

      // 1) Featured EN zone labels — galaxy region identifiers.
      //    Drawn at cluster centroid, always visible, no collision suppression.
      if (!focus) {
        // compute cluster centroids in screen space
        const clusterSx = new Map<number, number>()
        const clusterSy = new Map<number, number>()
        const clusterCnt = new Map<number, number>()
        for (const n of nodes) {
          if (n.x == null || n.cluster < 0) continue
          const sx = ox(n) * k + t.x
          const sy = oy(n) * k + t.y
          clusterSx.set(n.cluster, (clusterSx.get(n.cluster) || 0) + sx)
          clusterSy.set(n.cluster, (clusterSy.get(n.cluster) || 0) + sy)
          clusterCnt.set(n.cluster, (clusterCnt.get(n.cluster) || 0) + 1)
        }
        for (const n of nodes) {
          if (!n.featured || !n.en || n.cluster < 0) continue
          const cnt = clusterCnt.get(n.cluster) || 0
          if (!cnt) continue
          const sx = (clusterSx.get(n.cluster) || 0) / cnt
          const sy = (clusterSy.get(n.cluster) || 0) / cnt
          if (sx < -120 || sx > w + 120 || sy < -40 || sy > h + 40) continue
          ctx.font = `300 13px ${FONT_EN}`
          if ('letterSpacing' in ctx) (ctx as any).letterSpacing = '3px'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.globalAlpha = 0.28
          ctx.shadowColor = 'rgba(0,0,0,0.85)'
          ctx.shadowBlur = 6
          ctx.fillStyle = '#ccc8be'
          ctx.fillText(n.en.toUpperCase(), sx, sy)
          ctx.shadowBlur = 0
          if ('letterSpacing' in ctx) (ctx as any).letterSpacing = '0px'
        }
        ctx.globalAlpha = 1
      }

      // 2) focus mode: node + neighbours; else center + top hubs by zoom
      for (const n of nodes) {
        if (n.x == null) continue
        const inFocus = focus && (focus.id === n.id || neighbors?.has(n.id))
        const isFocus = focus?.id === n.id
        let show = false
        if (focus) {
          show = !!inFocus
        } else {
          if (n.private) show = false
          else if (n.isCenter) show = k > 0.5
          else if (n.featured) show = false // already drawn in EN
          else show = (k > 3 && n.degree >= 5) || (k > 2 && n.degree >= 9) || (k > 1.4 && n.degree >= 18)
        }
        if (!show) continue
        const label = n.title.length > 13 ? n.title.slice(0, 13) + '…' : n.title
        drawLabel(n, label, {
          dim: focus && !inFocus ? 0.25 : 0.95,
          weight: n.isCenter || isFocus ? 500 : 400,
          size: (n.isCenter ? 14 : isFocus ? 13 : 11),
        })
      }
      ctx.globalAlpha = 1

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    const onResize = () => {
      resize()
      simulation.alpha(0.15).restart()
    }
    window.addEventListener('resize', onResize)

    // expose fit for the reset button
    ;(canvas as any).__fit = () => fitView(700)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(fitFallback)
      simulation.stop()
      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onMoveTrack)
      canvas.removeEventListener('click', onClick)
      sel.on('.zoom', null)
      sel.on('.drag', null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph])

  const connections = useMemo(() => {
    if (!selected || !graph) return []
    const out: Array<{ node: GNode; kinds: string[] }> = []
    graph.links.forEach((l) => {
      const s = (typeof l.source === 'object' ? l.source.id : l.source) as string
      const t = (typeof l.target === 'object' ? l.target.id : l.target) as string
      let otherId: string | null = null
      if (s === selected.id) otherId = t
      else if (t === selected.id) otherId = s
      if (!otherId) return
      const node = graph.nodeById.get(otherId)
      if (node) out.push({ node, kinds: l.kinds })
    })
    return out.sort((a, b) => b.node.degree - a.node.degree)
  }, [selected, graph])

  const resetView = () => {
    setSelected(null)
    const canvas = mainRef.current as any
    if (canvas?.__fit) canvas.__fit()
  }

  // ============================================================
  // UI
  // ============================================================

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: INK }}>
        <div className="text-[13px] tracking-[0.5em] text-neutral-600 animate-pulse">CHANG-WIKI</div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="relative w-full h-screen overflow-hidden select-none" style={{ background: INK }}>
      <canvas ref={mainRef} className="absolute inset-0" />
      {/* faint vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.6) 100%)' }}
      />

      {/* Wordmark + single quote */}
      <div className="absolute top-8 left-9 z-20 max-w-[340px] animate-[fade_1.2s_ease-out]">
        <h1 className="text-[26px] font-light tracking-[0.12em] text-neutral-100">Chang-wiki</h1>
        <p className="mt-2.5 text-[12px] leading-relaxed text-neutral-500 font-light italic">
          The universe is made of stories, not of atoms.
        </p>
        <p className="mt-1 text-[10.5px] text-neutral-700 tracking-wide">— Muriel Rukeyser</p>
      </div>

      {/* Search */}
      <div className="absolute top-8 left-1/2 -translate-x-1/2 z-20 w-[280px] hidden sm:block">
        <div className="relative">
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            placeholder="搜索 / search"
            className="w-full px-0 py-2 bg-transparent border-b border-white/15 text-[13px] text-neutral-200 placeholder-neutral-600 outline-none focus:border-white/40 transition-colors text-center tracking-wide"
          />
          <AnimatePresence>
            {searchOpen && searchResults.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="absolute mt-2 w-full bg-[#0c0c10]/95 backdrop-blur-xl rounded-lg border border-white/10 overflow-hidden shadow-2xl"
              >
                {searchResults.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => {
                      selectNode(n)
                      setSearchOpen(false)
                      setQuery('')
                    }}
                    className="w-full px-3.5 py-2 flex items-center gap-2.5 text-left hover:bg-white/5 transition-colors"
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: n.tone }} />
                    <span className="text-[13px] text-neutral-300 truncate">{n.title}</span>
                    <span className="ml-auto text-[10px] text-neutral-600">{n.degree}</span>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Bottom-left controls — minimal */}
      <div className="absolute bottom-8 left-9 z-20 flex items-center gap-5 text-[11px] text-neutral-600">
        <button onClick={resetView} className="hover:text-neutral-300 transition-colors tracking-wide">
          全景
        </button>
        <button onClick={() => setLegendOpen((v) => !v)} className="hover:text-neutral-300 transition-colors tracking-wide">
          图例
        </button>
        {graph && (
          <span className="tracking-wide text-neutral-700">
            {graph.nodes.length} · {graph.links.length}
          </span>
        )}
      </div>

      {/* Legend — off by default, monochrome */}
      <AnimatePresence>
        {legendOpen && graph && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-20 left-9 z-20 w-[200px] bg-[#0c0c10]/85 backdrop-blur-xl rounded-lg border border-white/10 p-4"
          >
            <p className="text-[10px] text-neutral-600 mb-2.5 tracking-[0.2em]">聚类</p>
            <div className="space-y-1.5 max-h-[240px] overflow-y-auto thin-scroll pr-1">
              {graph.clusters.slice(0, 12).map((c) => (
                <div key={c.id} className="flex items-center gap-2.5 text-[12px]">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: c.tone }} />
                  <span className="text-neutral-400 truncate">{c.name}</span>
                  <span className="ml-auto text-neutral-700 tabular-nums text-[11px]">{c.count}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Detail panel — monochrome */}
      <AnimatePresence>
        {selected && (
          <motion.div
            key={selected.id}
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 30 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            className="absolute top-8 right-8 bottom-8 z-20 w-[330px] max-w-[calc(100vw-48px)] flex flex-col bg-[#0a0a0e]/85 backdrop-blur-2xl rounded-xl border border-white/10 overflow-hidden"
          >
            <div className="p-6 pb-4 border-b border-white/5">
              <button
                onClick={() => setSelected(null)}
                className="absolute top-5 right-5 w-7 h-7 rounded-md flex items-center justify-center text-neutral-600 hover:text-neutral-200 hover:bg-white/10 transition-all"
              >
                ✕
              </button>
              <div className="flex items-center gap-2.5 pr-8">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: selected.tone }} />
                <h2
                  className="text-[20px] font-normal text-neutral-100 leading-snug"
                  style={{ fontFamily: '"Songti SC","Source Han Serif SC","Noto Serif SC",serif' }}
                >
                  {selected.en ? (
                    <>
                      {selected.title}
                      <span className="ml-2 text-[13px] text-neutral-500 tracking-wide">{selected.en}</span>
                    </>
                  ) : (
                    selected.title
                  )}
                </h2>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-neutral-400">
                  {selected.ghost ? '未建页' : TYPE_LABELS[selected.type] || selected.type}
                </span>
                {graph?.clusters.find((c) => c.id === selected.cluster) && (
                  <span className="px-2 py-0.5 rounded-full border border-white/10 text-neutral-400">
                    {graph.clusters.find((c) => c.id === selected.cluster)!.name}
                  </span>
                )}
              </div>

              {selected.summary && (
                <p className="mt-3.5 text-[12.5px] leading-relaxed text-neutral-400 font-light">{selected.summary}</p>
              )}
              {selected.ghost && (
                <p className="mt-3.5 text-[11px] leading-relaxed text-neutral-600 font-light">
                  未建页 · 被 {selected.degree} 处引用，尚无独立条目。
                </p>
              )}
              {selected.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {selected.tags.slice(0, 8).map((tg) => (
                    <span key={tg} className="text-[10px] text-neutral-600">#{tg}</span>
                  ))}
                </div>
              )}
            </div>

            <div className="px-6 py-3 text-[11px] text-neutral-600 flex items-center justify-between">
              <span>{connections.length} 条关联</span>
              <div className="flex items-center gap-3">
                <button onClick={() => flyTo(selected)} className="hover:text-neutral-300 transition-colors tracking-wide">定位</button>
                {selected.updated && <span className="text-neutral-700">{selected.updated}</span>}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 pb-4 thin-scroll">
              {connections.map(({ node, kinds }, i) => (
                <button
                  key={node.id + i}
                  onClick={() => selectNode(node)}
                  className="w-full px-3 py-2 rounded-lg flex items-center gap-2.5 text-left hover:bg-white/5 transition-colors group"
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: node.tone }} />
                  <span className="text-[13px] text-neutral-400 group-hover:text-neutral-100 truncate transition-colors">
                    {node.title}
                  </span>
                  <span className="ml-auto text-[10px] text-neutral-700 shrink-0">{KIND_LABELS[kinds[0]] || kinds[0]}</span>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// small hex→rgb helper for edge tinting
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}
