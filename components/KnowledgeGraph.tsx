'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { motion, AnimatePresence } from 'framer-motion'

// ============================================================
// Types
// ============================================================

interface GNode extends d3.SimulationNodeDatum {
  id: string
  title: string
  type: string
  domain: string[]
  degree: number
  radius: number
  cluster: number
  color: string
  isCenter: boolean
  virtual: boolean
  phase: number
  updated?: string
}

interface GLink {
  source: string | GNode
  target: string | GNode
  weight: number
}

interface ClusterInfo {
  id: number
  name: string
  color: string
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
// Constants
// ============================================================

const CENTER_TITLE = '常天喆'
const CENTER_COLOR = '#fbbf24'

const TYPE_LABELS: Record<string, string> = {
  entity: '实体',
  concept: '概念',
  source: '来源',
  timeline: '时间线',
  mention: '隐含',
}

const CLUSTER_PALETTE = [
  '#22d3ee', // cyan
  '#a78bfa', // violet
  '#f472b6', // pink
  '#34d399', // emerald
  '#fb923c', // orange
  '#60a5fa', // blue
  '#e879f9', // fuchsia
  '#2dd4bf', // teal
  '#facc15', // yellow
  '#f87171', // red
]
const MISC_COLOR = '#7c8aa0'

// ============================================================
// Data pipeline
// ============================================================

function normalizeType(t: string): string {
  if (t === 'source-summary') return 'source'
  if (t === 'exploration' || t === 'meta') return 'concept'
  return t
}

function buildGraph(data: any): Graph {
  const rawPages = (data.pages as any[]).filter(
    (p) => !p.path.includes('EXAMPLE') && !p.title.startsWith('EXAMPLE')
  )

  const pathSet = new Set(rawPages.map((p) => p.path))
  const titleToPath = new Map<string, string>()
  rawPages.forEach((p) => titleToPath.set(p.title, p.path))

  const nodes: GNode[] = rawPages.map((p) => ({
    id: p.path,
    title: p.title,
    type: normalizeType(p.type),
    domain: p.domain || [],
    degree: 0,
    radius: 4,
    cluster: -1,
    color: MISC_COLOR,
    isCenter: p.title === CENTER_TITLE,
    virtual: false,
    phase: Math.random() * Math.PI * 2,
    updated: p.updated,
  }))

  // ---- Edges from resolved links (dedupe + weight) ----
  const edgeMap = new Map<string, GLink>()
  const addEdge = (a: string, b: string) => {
    if (a === b) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    const e = edgeMap.get(key)
    if (e) e.weight += 1
    else edgeMap.set(key, { source: a, target: b, weight: 1 })
  }

  rawPages.forEach((p) => {
    ;(p.resolved_outbound_links || []).forEach((t: string) => {
      if (pathSet.has(t)) addEdge(p.path, t)
    })
  })

  // ---- Virtual nodes from frequently mentioned but pageless names ----
  const mentionCount = new Map<string, number>()
  const mentionEdges: Array<[string, string]> = []
  rawPages.forEach((p) => {
    const seen = new Set<string>()
    ;(p.outbound_links || []).forEach((name: string) => {
      if (
        name.endsWith('.md') ||
        name.includes('/') ||
        name.startsWith('EXAMPLE') ||
        name.length > 24 ||
        titleToPath.has(name) ||
        seen.has(name)
      )
        return
      seen.add(name)
      mentionCount.set(name, (mentionCount.get(name) || 0) + 1)
      mentionEdges.push([p.path, name])
    })
  })

  const virtualIds = new Map<string, string>()
  mentionCount.forEach((count, name) => {
    if (count < 2) return
    const id = `mention:${name}`
    virtualIds.set(name, id)
    nodes.push({
      id,
      title: name,
      type: 'mention',
      domain: [],
      degree: 0,
      radius: 3.5,
      cluster: -1,
      color: MISC_COLOR,
      isCenter: false,
      virtual: true,
      phase: Math.random() * Math.PI * 2,
    })
  })
  mentionEdges.forEach(([page, name]) => {
    const vid = virtualIds.get(name)
    if (vid) addEdge(page, vid)
  })

  // ---- Degree + prune isolated nodes ----
  const degree = new Map<string, number>()
  edgeMap.forEach((e) => {
    degree.set(e.source as string, (degree.get(e.source as string) || 0) + 1)
    degree.set(e.target as string, (degree.get(e.target as string) || 0) + 1)
  })
  const keptNodes = nodes.filter((n) => (degree.get(n.id) || 0) > 0)
  const keptIds = new Set(keptNodes.map((n) => n.id))
  const links = Array.from(edgeMap.values()).filter(
    (e) => keptIds.has(e.source as string) && keptIds.has(e.target as string)
  )
  keptNodes.forEach((n) => (n.degree = degree.get(n.id) || 0))

  // ---- Adjacency (with weights for clustering) ----
  const adjacency = new Map<string, Set<string>>()
  const wAdj = new Map<string, Array<[string, number]>>()
  keptNodes.forEach((n) => {
    adjacency.set(n.id, new Set())
    wAdj.set(n.id, [])
  })
  links.forEach((e) => {
    const s = e.source as string
    const t = e.target as string
    adjacency.get(s)!.add(t)
    adjacency.get(t)!.add(s)
    wAdj.get(s)!.push([t, e.weight])
    wAdj.get(t)!.push([s, e.weight])
  })

  // ---- Community detection: weighted label propagation ----
  // The center node and source/timeline pages bridge unrelated topics,
  // so they sit out of voting and get assigned by neighborhood afterwards.
  const nodeById = new Map(keptNodes.map((n) => [n.id, n]))
  const isNeutral = (n: GNode) =>
    n.isCenter || n.type === 'source' || n.type === 'timeline'

  const labels = new Map<string, number>()
  keptNodes.forEach((n, i) => labels.set(n.id, i))

  const voters = keptNodes
    .filter((n) => !isNeutral(n))
    .sort((a, b) => b.degree - a.degree)

  for (let iter = 0; iter < 20; iter++) {
    let changed = 0
    for (const n of voters) {
      const tally = new Map<number, number>()
      for (const [nb, w] of wAdj.get(n.id)!) {
        const nbNode = nodeById.get(nb)!
        if (isNeutral(nbNode)) continue
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

  // Neutral nodes adopt the majority label among their voting neighbors
  keptNodes.forEach((n) => {
    if (!isNeutral(n)) return
    const tally = new Map<number, number>()
    for (const [nb, w] of wAdj.get(n.id)!) {
      const nbNode = nodeById.get(nb)!
      if (isNeutral(nbNode)) continue
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

  // ---- Rank clusters, name them after their biggest hub ----
  const clusterMembers = new Map<number, GNode[]>()
  keptNodes.forEach((n) => {
    const l = labels.get(n.id)!
    if (!clusterMembers.has(l)) clusterMembers.set(l, [])
    clusterMembers.get(l)!.push(n)
  })
  const ranked = Array.from(clusterMembers.entries()).sort(
    (a, b) => b[1].length - a[1].length
  )

  const clusters: ClusterInfo[] = []
  ranked.forEach(([label, members], idx) => {
    const color = idx < CLUSTER_PALETTE.length ? CLUSTER_PALETTE[idx] : MISC_COLOR
    // Name the cluster after its biggest entity/concept hub; long source
    // document titles make terrible constellation names.
    const sorted = members
      .filter((m) => !m.isCenter)
      .sort((a, b) => b.degree - a.degree)
    const hub =
      sorted.find(
        (m) => m.type !== 'source' && m.type !== 'timeline' && m.title.length <= 12
      ) || sorted[0]
    const clusterId = idx
    if (idx < CLUSTER_PALETTE.length && members.length >= 3) {
      clusters.push({
        id: clusterId,
        name: hub ? hub.title : `星系 ${idx + 1}`,
        color,
        count: members.length,
      })
    }
    members.forEach((m) => {
      m.cluster = clusterId
      m.color = members.length >= 3 && idx < CLUSTER_PALETTE.length ? color : MISC_COLOR
    })
  })

  // ---- Visual size: degree-driven ----
  keptNodes.forEach((n) => {
    const base = n.virtual ? 2.6 : n.type === 'timeline' ? 5 : 3.2
    n.radius = Math.min(15, base + Math.sqrt(n.degree) * 1.15)
    if (n.isCenter) {
      n.radius = 19
      n.color = CENTER_COLOR
    }
  })

  return { nodes: keptNodes, links, clusters, adjacency, nodeById }
}

// ============================================================
// Glow sprite cache (pre-rendered radial gradients)
// ============================================================

const spriteCache = new Map<string, HTMLCanvasElement>()
function glowSprite(color: string): HTMLCanvasElement {
  let c = spriteCache.get(color)
  if (c) return c
  c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, color)
  g.addColorStop(0.25, color + 'aa')
  g.addColorStop(0.6, color + '33')
  g.addColorStop(1, color + '00')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  spriteCache.set(color, c)
  return c
}

// ============================================================
// Component
// ============================================================

export default function KnowledgeGraph() {
  const bgRef = useRef<HTMLCanvasElement>(null)
  const mainRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const [graph, setGraph] = useState<Graph | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<GNode | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())
  const [panelOpen, setPanelOpen] = useState(true)

  const graphRef = useRef<Graph | null>(null)
  const transformRef = useRef(d3.zoomIdentity)
  const hoverRef = useRef<GNode | null>(null)
  const selectedRef = useRef<GNode | null>(null)
  const hiddenRef = useRef<Set<string>>(new Set())
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const searchInputRef = useRef<HTMLInputElement>(null)

  selectedRef.current = selected
  hiddenRef.current = hiddenTypes

  // Collapse the legend by default on small screens
  useEffect(() => {
    if (window.innerWidth < 640) setPanelOpen(false)
  }, [])

  // ---------- Load data ----------
  useEffect(() => {
    fetch('/data/_index.json')
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

  // ---------- Search ----------
  const searchResults = useMemo(() => {
    if (!graph || !query.trim()) return []
    const q = query.trim().toLowerCase()
    return graph.nodes
      .filter((n) => n.title.toLowerCase().includes(q))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 8)
  }, [graph, query])

  // ---------- Fly to node ----------
  const flyTo = (node: GNode, scale = 1.6) => {
    const canvas = mainRef.current
    const zoom = zoomRef.current
    if (!canvas || !zoom || node.x == null) return
    const { w, h } = sizeRef.current
    const t = d3.zoomIdentity
      .translate(w / 2, h / 2)
      .scale(scale)
      .translate(-node.x!, -node.y!)
    d3.select(canvas).transition().duration(900).ease(d3.easeCubicInOut).call(zoom.transform as any, t)
  }

  const selectNode = (node: GNode) => {
    setSelected(node)
    flyTo(node)
  }

  // ---------- Keyboard shortcuts ----------
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

  // ---------- Main canvas setup ----------
  useEffect(() => {
    if (!graph || !mainRef.current || !bgRef.current) return

    const canvas = mainRef.current
    const bgCanvas = bgRef.current
    const ctx = canvas.getContext('2d')!
    const bgCtx = bgCanvas.getContext('2d')!

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = window.innerWidth
      const h = window.innerHeight
      sizeRef.current = { w, h, dpr }
      ;[canvas, bgCanvas].forEach((c) => {
        c.width = w * dpr
        c.height = h * dpr
        c.style.width = `${w}px`
        c.style.height = `${h}px`
      })
    }
    resize()

    // ---- Starfield (screen-space, slight pan parallax) ----
    const stars = Array.from({ length: 380 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.3 + 0.3,
      base: Math.random() * 0.5 + 0.15,
      amp: Math.random() * 0.35,
      speed: Math.random() * 0.0015 + 0.0004,
      phase: Math.random() * Math.PI * 2,
      layer: Math.random() < 0.5 ? 0.03 : 0.07,
    }))

    interface Meteor {
      x: number; y: number; vx: number; vy: number; life: number; max: number
    }
    let meteors: Meteor[] = []
    let nextMeteor = performance.now() + 3000

    // ---- Simulation ----
    const { nodes, links, nodeById, adjacency } = graph
    const center = nodes.find((n) => n.isCenter)
    if (center) {
      center.fx = 0
      center.fy = 0
    }

    const simulation = d3
      .forceSimulation<GNode>(nodes)
      .velocityDecay(0.32)
      .force(
        'link',
        d3
          .forceLink<GNode, any>(links as any)
          .id((d: any) => d.id)
          .distance((l: any) => 95 - Math.min(l.weight, 4) * 10)
          .strength((l: any) => Math.min(1, 0.35 + l.weight * 0.15))
      )
      .force(
        'charge',
        d3.forceManyBody<GNode>().strength((d) => (d.isCenter ? -1400 : -60 - d.radius * 18))
      )
      .force('x', d3.forceX(0).strength(0.025))
      .force('y', d3.forceY(0).strength(0.03))
      .force(
        'collide',
        d3.forceCollide<GNode>().radius((d) => d.radius + 5)
      )
      .alpha(1)
      .alphaDecay(0.018)

    // ---- Zoom ----
    const findNode = (sx: number, sy: number): GNode | undefined => {
      const t = transformRef.current
      const [x, y] = t.invert([sx, sy])
      const n = simulation.find(x, y, Math.max(18 / t.k, 14))
      if (!n) return undefined
      if (hiddenRef.current.has(n.type)) return undefined
      return n
    }

    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.08, 6])
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

    // Opening shot: drift in from deep space
    const { w, h } = sizeRef.current
    const start = d3.zoomIdentity.translate(w / 2, h / 2).scale(0.05)
    const end = d3.zoomIdentity.translate(w / 2, h / 2).scale(0.55)
    sel.call(zoom.transform as any, start)
    sel
      .transition()
      .duration(2400)
      .ease(d3.easeCubicOut)
      .call(zoom.transform as any, end)

    // ---- Drag ----
    const drag = d3
      .drag<HTMLCanvasElement, unknown>()
      .subject((event: any) => {
        const [sx, sy] = d3.pointer(event, canvas)
        const n = findNode(sx, sy)
        return n && !n.isCenter ? n : (null as any)
      })
      .on('start', (event: any) => {
        if (!event.active) simulation.alphaTarget(0.25).restart()
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

    // ---- Hover / click ----
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
      if (n) {
        setSelected(n)
        flyTo(n)
      } else {
        setSelected(null)
      }
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onMoveTrack)
    canvas.addEventListener('click', onClick)

    // ---- Render loop ----
    let raf = 0

    const drawBackground = (time: number) => {
      const { w, h, dpr } = sizeRef.current
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      bgCtx.clearRect(0, 0, w, h)

      const t = transformRef.current

      // stars
      for (const s of stars) {
        const tw = s.base + Math.sin(time * s.speed + s.phase) * s.amp
        if (tw <= 0.02) continue
        const px = (s.x * w + t.x * s.layer + w) % w
        const py = (s.y * h + t.y * s.layer + h) % h
        bgCtx.globalAlpha = Math.max(0, Math.min(1, tw))
        bgCtx.fillStyle = '#cfe2ff'
        bgCtx.beginPath()
        bgCtx.arc(px, py, s.r, 0, Math.PI * 2)
        bgCtx.fill()
      }
      bgCtx.globalAlpha = 1

      // meteors
      if (time > nextMeteor) {
        nextMeteor = time + 4000 + Math.random() * 6000
        const fromTop = Math.random() < 0.7
        meteors.push({
          x: Math.random() * w * 0.8 + w * 0.2,
          y: fromTop ? -20 : Math.random() * h * 0.3,
          vx: -(2.5 + Math.random() * 3),
          vy: 2 + Math.random() * 2.5,
          life: 0,
          max: 60 + Math.random() * 40,
        })
      }
      meteors = meteors.filter((m) => m.life < m.max)
      for (const m of meteors) {
        m.x += m.vx
        m.y += m.vy
        m.life++
        const fade = Math.sin((m.life / m.max) * Math.PI)
        const grad = bgCtx.createLinearGradient(m.x, m.y, m.x - m.vx * 14, m.y - m.vy * 14)
        grad.addColorStop(0, `rgba(190,225,255,${0.85 * fade})`)
        grad.addColorStop(1, 'rgba(190,225,255,0)')
        bgCtx.strokeStyle = grad
        bgCtx.lineWidth = 1.4
        bgCtx.beginPath()
        bgCtx.moveTo(m.x, m.y)
        bgCtx.lineTo(m.x - m.vx * 14, m.y - m.vy * 14)
        bgCtx.stroke()
      }
    }

    const draw = (time: number) => {
      const { w, h, dpr } = sizeRef.current
      const t = transformRef.current
      const hidden = hiddenRef.current
      const focus = hoverRef.current || selectedRef.current
      const neighbors = focus ? adjacency.get(focus.id) : null

      drawBackground(time)

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.translate(t.x, t.y)
      ctx.scale(t.k, t.k)

      const visible = (n: GNode) => !hidden.has(n.type)
      // ambient drift offset, applied uniformly
      const ox = (n: GNode) => n.x! + Math.sin(time * 0.00045 + n.phase) * 1.4
      const oy = (n: GNode) => n.y! + Math.cos(time * 0.0004 + n.phase * 1.3) * 1.4

      // ---- nebulas at cluster centroids ----
      ctx.globalCompositeOperation = 'screen'
      for (const c of graph.clusters.slice(0, 8)) {
        let cx = 0, cy = 0, m = 0
        for (const n of nodes) {
          if (n.cluster !== c.id || n.x == null || n.y == null) continue
          cx += n.x
          cy += n.y
          m++
        }
        if (m < 3) continue
        cx /= m
        cy /= m
        const r = 70 + Math.sqrt(m) * 34
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
        g.addColorStop(0, c.color + '14')
        g.addColorStop(0.6, c.color + '0a')
        g.addColorStop(1, c.color + '00')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fill()
      }

      // ---- links ----
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'
      for (const l of links) {
        const s = l.source as GNode
        const tg = l.target as GNode
        if (s.x == null || tg.x == null) continue
        if (!visible(s) || !visible(tg)) continue

        let alpha = 0.1 + Math.min(l.weight, 5) * 0.05
        let width = 0.6 + Math.min(l.weight, 5) * 0.35
        let color = s.cluster === tg.cluster ? s.color : '#8aa3c2'

        if (focus) {
          const touches = s.id === focus.id || tg.id === focus.id
          if (touches) {
            alpha = 0.85
            width += 0.6
            color = focus.color === MISC_COLOR ? '#b8cce8' : focus.color
          } else {
            alpha *= 0.12
          }
        }

        const x1 = ox(s), y1 = oy(s), x2 = ox(tg), y2 = oy(tg)
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
        const dx = x2 - x1, dy = y2 - y1
        const bend = 0.14
        ctx.globalAlpha = alpha
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.quadraticCurveTo(mx - dy * bend, my + dx * bend, x2, y2)
        ctx.stroke()
      }

      // ---- nodes ----
      for (const n of nodes) {
        if (n.x == null || !visible(n)) continue
        let alpha = n.virtual ? 0.8 : 1
        if (focus && focus.id !== n.id && !neighbors?.has(n.id)) alpha *= 0.13

        const x = ox(n), y = oy(n)
        const isFocus = focus?.id === n.id

        // glow
        const sprite = glowSprite(n.color)
        const glowR = n.radius * (n.isCenter ? 4.2 + Math.sin(time / 480) * 0.5 : isFocus ? 4.4 : 3.2)
        ctx.globalAlpha = alpha * (n.isCenter ? 0.95 : isFocus ? 0.9 : 0.55)
        ctx.drawImage(sprite, x - glowR, y - glowR, glowR * 2, glowR * 2)

        // core
        ctx.globalAlpha = alpha
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = n.isCenter ? '#fff7e0' : '#ffffff'
        ctx.beginPath()
        ctx.arc(x, y, Math.max(1.2, n.radius * 0.42), 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = n.color
        ctx.globalAlpha = alpha * 0.85
        ctx.beginPath()
        ctx.arc(x, y, n.radius * (isFocus ? 1.18 : 1), 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.globalAlpha = alpha * 0.9
        ctx.beginPath()
        ctx.arc(x, y, Math.max(1, n.radius * 0.38), 0, Math.PI * 2)
        ctx.fill()

        // selection ring
        if (selectedRef.current?.id === n.id) {
          ctx.globalAlpha = 0.9
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1.2 / t.k
          ctx.setLineDash([4 / t.k, 4 / t.k])
          ctx.lineDashOffset = -time / 60
          ctx.beginPath()
          ctx.arc(x, y, n.radius + 7 / t.k, 0, Math.PI * 2)
          ctx.stroke()
          ctx.setLineDash([])
        }
        ctx.globalCompositeOperation = 'lighter'
      }

      // ---- labels ----
      ctx.globalCompositeOperation = 'source-over'
      const k = t.k
      const minX = -t.x / k, minY = -t.y / k
      const maxX = (w - t.x) / k, maxY = (h - t.y) / k
      for (const n of nodes) {
        if (n.x == null || !visible(n)) continue
        const x = ox(n), y = oy(n)
        if (x < minX || x > maxX || y < minY || y > maxY) continue

        const isFocusArea =
          focus && (focus.id === n.id || neighbors?.has(n.id))
        const show =
          n.isCenter ||
          isFocusArea ||
          (!focus && (n.degree >= 10 || k > 2 || (k > 1.1 && n.degree >= 4)))
        if (!show) continue
        if (focus && !isFocusArea && !n.isCenter) continue

        const fontSize = (n.isCenter ? 14 : focus?.id === n.id ? 13 : 11) / k
        ctx.font = `${n.isCenter || focus?.id === n.id ? 600 : 400} ${fontSize}px -apple-system, "PingFang SC", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const ty = y + n.radius + 4 / k
        ctx.globalAlpha = focus && !isFocusArea ? 0.3 : 0.95
        ctx.shadowColor = 'rgba(2,6,18,0.95)'
        ctx.shadowBlur = 4
        ctx.fillStyle = focus?.id === n.id ? '#ffffff' : '#c8d8ee'
        const label = n.title.length > 14 ? n.title.slice(0, 14) + '…' : n.title
        ctx.fillText(label, x, ty)
        ctx.shadowBlur = 0
      }
      ctx.globalAlpha = 1
    }

    const loop = (time: number) => {
      draw(time)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    const onResize = () => {
      resize()
      simulation.alpha(0.2).restart()
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
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

  // ---------- Derived: selected node's connections ----------
  const connections = useMemo(() => {
    if (!selected || !graph) return []
    const ids = graph.adjacency.get(selected.id)
    if (!ids) return []
    return Array.from(ids)
      .map((id) => graph.nodeById.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.degree - a.degree)
  }, [selected, graph])

  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const resetView = () => {
    const canvas = mainRef.current
    const zoom = zoomRef.current
    if (!canvas || !zoom) return
    const { w, h } = sizeRef.current
    setSelected(null)
    d3.select(canvas)
      .transition()
      .duration(900)
      .ease(d3.easeCubicInOut)
      .call(zoom.transform as any, d3.zoomIdentity.translate(w / 2, h / 2).scale(0.55))
  }

  // ============================================================
  // UI
  // ============================================================

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#030712] gap-6">
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 rounded-full border-2 border-cyan-400/20" />
          <div className="absolute inset-0 rounded-full border-t-2 border-cyan-300 animate-spin" />
          <div className="absolute inset-[26px] rounded-full bg-amber-300 shadow-[0_0_24px_6px_rgba(251,191,36,0.6)]" />
        </div>
        <div className="text-sm tracking-[0.4em] text-slate-400">构建知识星图中</div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="relative w-full h-screen overflow-hidden bg-[#030712] select-none">
      {/* deep space backdrop */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 30% 20%, rgba(34,60,110,0.25), transparent 60%),' +
            'radial-gradient(ellipse 70% 60% at 75% 75%, rgba(60,30,90,0.22), transparent 65%),' +
            'radial-gradient(ellipse 100% 80% at 50% 50%, rgba(8,15,35,0.5), #030712 100%)',
        }}
      />
      <canvas ref={bgRef} className="absolute inset-0" />
      <canvas ref={mainRef} className="absolute inset-0" />
      {/* vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(1,4,12,0.55) 100%)' }}
      />

      {/* ===== Identity / control card ===== */}
      <div className="absolute top-5 left-5 z-20 max-w-[300px]">
        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.8 }}
          className="bg-[#0a1222]/70 backdrop-blur-2xl rounded-2xl border border-white/10 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden"
        >
          <div className="p-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="relative w-10 h-10 shrink-0">
                <div className="absolute inset-0 rounded-full bg-amber-300/90 blur-[10px]" />
                <div className="absolute inset-[7px] rounded-full bg-gradient-to-br from-amber-100 to-amber-400 shadow-[0_0_18px_4px_rgba(251,191,36,0.55)]" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-white leading-tight">常天喆 · 知识星图</h1>
                <p className="text-[11px] text-slate-400 mt-0.5 tracking-wide">
                  AI 产品经理 · 文学 × 哲学 × AI
                </p>
              </div>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-slate-400">
              我读过的、想过的、做过的，都在这片星空里。每一簇星系是一个思想领域，连线是它们之间真实的引用关系。
            </p>
          </div>

          <button
            onClick={() => setPanelOpen((v) => !v)}
            className="w-full px-5 py-2 text-[11px] text-slate-500 hover:text-slate-300 border-t border-white/5 flex items-center justify-between transition-colors"
          >
            <span>星系图例 & 筛选</span>
            <span>{panelOpen ? '收起 ▲' : '展开 ▼'}</span>
          </button>

          <AnimatePresence initial={false}>
            {panelOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="overflow-hidden"
              >
                <div className="px-5 pb-4">
                  {/* cluster legend */}
                  <div className="space-y-1.5 max-h-[180px] overflow-y-auto pr-1 thin-scroll">
                    {graph?.clusters.slice(0, 8).map((c) => (
                      <div key={c.id} className="flex items-center gap-2.5 text-[12px]">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: c.color, boxShadow: `0 0 8px ${c.color}` }}
                        />
                        <span className="text-slate-300 truncate">{c.name} 星系</span>
                        <span className="ml-auto text-slate-600 tabular-nums">{c.count}</span>
                      </div>
                    ))}
                  </div>

                  {/* type filters */}
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {Object.entries(TYPE_LABELS).map(([type, label]) => {
                      const off = hiddenTypes.has(type)
                      return (
                        <button
                          key={type}
                          onClick={() => toggleType(type)}
                          className={`px-2.5 py-1 rounded-full text-[11px] border transition-all ${
                            off
                              ? 'border-white/5 text-slate-600 bg-transparent'
                              : 'border-white/15 text-slate-200 bg-white/5'
                          }`}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>

                  {/* stats */}
                  <div className="mt-4 pt-3 border-t border-white/5 flex gap-4 text-[11px] text-slate-500">
                    <span>✦ {graph?.nodes.length} 星体</span>
                    <span>⟡ {graph?.links.length} 连线</span>
                    <span>❖ {graph?.clusters.length} 星系</span>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      {/* ===== Search ===== */}
      <div className="absolute top-5 left-1/2 -translate-x-1/2 z-20 w-[300px] hidden sm:block">
        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.8 }}
          className="relative"
        >
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            placeholder="搜索星体…（按 / 聚焦）"
            className="w-full px-4 py-2.5 rounded-xl bg-[#0a1222]/70 backdrop-blur-2xl border border-white/10 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-400/40 transition-colors shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
          />
          <AnimatePresence>
            {searchOpen && searchResults.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="absolute mt-2 w-full bg-[#0a1222]/90 backdrop-blur-2xl rounded-xl border border-white/10 overflow-hidden shadow-2xl"
              >
                {searchResults.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => {
                      selectNode(n)
                      setSearchOpen(false)
                      setQuery('')
                    }}
                    className="w-full px-4 py-2.5 flex items-center gap-2.5 text-left hover:bg-white/5 transition-colors"
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: n.color, boxShadow: `0 0 6px ${n.color}` }}
                    />
                    <span className="text-sm text-slate-200 truncate">{n.title}</span>
                    <span className="ml-auto text-[10px] text-slate-500">
                      {TYPE_LABELS[n.type] || n.type} · {n.degree}
                    </span>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      {/* ===== Reset view ===== */}
      <div className="absolute bottom-5 left-5 z-20 flex items-center gap-3">
        <button
          onClick={resetView}
          className="px-3.5 py-2 rounded-xl bg-[#0a1222]/70 backdrop-blur-2xl border border-white/10 text-[12px] text-slate-300 hover:text-white hover:border-white/25 transition-all"
        >
          ⊙ 回到全景
        </button>
        <span className="text-[11px] text-slate-600 hidden md:inline">
          拖拽星体 · 滚轮缩放 · 点击查看 · Esc 取消
        </span>
      </div>

      {/* ===== Detail panel ===== */}
      <AnimatePresence>
        {selected && (
          <motion.div
            key={selected.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            className="absolute top-5 right-5 bottom-5 z-20 w-[320px] max-w-[calc(100vw-40px)] flex flex-col bg-[#0a1222]/75 backdrop-blur-2xl rounded-2xl border border-white/10 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden"
          >
            <div className="p-5 pb-4 border-b border-white/5">
              <button
                onClick={() => setSelected(null)}
                className="absolute top-4 right-4 w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-white hover:bg-white/10 transition-all"
              >
                ✕
              </button>
              <div className="flex items-center gap-2.5 pr-8">
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: selected.color, boxShadow: `0 0 12px ${selected.color}` }}
                />
                <h2 className="text-lg font-semibold text-white leading-snug">{selected.title}</h2>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="px-2 py-0.5 rounded-full text-[11px] bg-white/5 border border-white/10 text-slate-300">
                  {TYPE_LABELS[selected.type] || selected.type}
                </span>
                {graph?.clusters.find((c) => c.id === selected.cluster) && (
                  <span
                    className="px-2 py-0.5 rounded-full text-[11px] border"
                    style={{
                      color: selected.color,
                      borderColor: selected.color + '55',
                      backgroundColor: selected.color + '14',
                    }}
                  >
                    {graph.clusters.find((c) => c.id === selected.cluster)!.name} 星系
                  </span>
                )}
                {selected.domain.map((d) => (
                  <span
                    key={d}
                    className="px-2 py-0.5 rounded-full text-[11px] bg-white/5 border border-white/10 text-slate-400"
                  >
                    {d}
                  </span>
                ))}
              </div>
              {selected.virtual && (
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                  这是一颗「隐含星体」—— 被 {selected.degree} 个页面引用，但尚未拥有自己的页面。
                </p>
              )}
            </div>

            <div className="px-5 py-3 text-[11px] text-slate-500 flex items-center justify-between">
              <span>{connections.length} 条关联</span>
              {selected.updated && <span>更新于 {selected.updated}</span>}
            </div>

            <div className="flex-1 overflow-y-auto px-3 pb-3 thin-scroll">
              {connections.map((n) => (
                <button
                  key={n.id}
                  onClick={() => selectNode(n)}
                  className="w-full px-3 py-2 rounded-xl flex items-center gap-2.5 text-left hover:bg-white/5 transition-colors group"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: n.color, boxShadow: `0 0 6px ${n.color}` }}
                  />
                  <span className="text-[13px] text-slate-300 group-hover:text-white truncate transition-colors">
                    {n.title}
                  </span>
                  <span className="ml-auto text-[10px] text-slate-600 shrink-0">
                    {TYPE_LABELS[n.type] || n.type}
                  </span>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
