'use client'

import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { motion, AnimatePresence } from 'framer-motion'

interface Node {
  id: string
  title: string
  type: string
  domain: string[]
  group: number
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
  vx?: number
  vy?: number
}

interface Link {
  source: string | Node
  target: string | Node
  value: number
}

interface GraphData {
  nodes: Node[]
  links: Link[]
}

const typeColors = {
  entity: '#ffffff',
  concept: '#a5f3fc',
  source: '#67e8f9',
  timeline: '#22d3ee',
  meta: '#0ea5e9',
  exploration: '#0891b2',
}

const typeLabels = {
  entity: '实体',
  concept: '概念',
  source: '来源',
  timeline: '时间线',
  meta: '元数据',
  exploration: '探索',
}

export default function KnowledgeGraph() {
  const svgRef = useRef<SVGSVGElement>(null)
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [graphData, setGraphData] = useState<GraphData | null>(null)
  const simulationRef = useRef<d3.Simulation<Node, Link> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch('/data/_index.json')
        const data = await response.json()
        
        const nodes: Node[] = data.pages.map((page: any, index: number) => ({
          id: page.path,
          title: page.title,
          type: page.type,
          domain: page.domain || [],
          group: getGroupIndex(page.type),
        }))

        const links: Link[] = []
        const nodeMap = new Map(nodes.map(n => [n.id, n]))

        data.pages.forEach((page: any) => {
          page.resolved_outbound_links?.forEach((targetId: string) => {
            if (nodeMap.has(targetId) && nodeMap.has(page.path)) {
              links.push({
                source: page.path,
                target: targetId,
                value: 1,
              })
            }
          })
        })

        setGraphData({ nodes, links })
        setLoading(false)
      } catch (error) {
        console.error('Error loading graph data:', error)
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  useEffect(() => {
    if (!graphData || !svgRef.current) return

    const svg = d3.select(svgRef.current)
    const width = window.innerWidth
    const height = window.innerHeight - 100

    svg.selectAll('*').remove()

    const g = svg.append('g')

    const zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event: any) => {
        g.attr('transform', event.transform)
      })

    svg.call(zoom as any)

    const link = g.append('g')
      .selectAll('line')
      .data(graphData.links)
      .join('line')
      .attr('class', 'link')
      .attr('stroke', '#64748b')
      .attr('stroke-opacity', 0.3)
      .attr('stroke-width', 1)
      .style('filter', 'url(#glow-link)')

    const defs = svg.append('defs')

    defs.append('filter')
      .attr('id', 'glow-link')
      .append('feGaussianBlur')
      .attr('stdDeviation', '2')
      .attr('result', 'coloredBlur')

    const defs2 = defs.node()
    const glowLink = d3.select(defs2).select('#glow-link')
    glowLink.append('feMerge')
      .selectAll('feMergeNode')
      .data(['coloredBlur', 'SourceGraphic'])
      .enter()
      .append('feMergeNode')
      .attr('in', (d: any) => d)

    const nodeMap = new Map(graphData.nodes.map(n => [n.id, n]))
    const centerNode = graphData.nodes.find(n => n.title === '常天喆')

    if (centerNode) {
      centerNode.fx = width / 2
      centerNode.fy = height / 2
    }

    const node = g.append('g')
      .selectAll('circle')
      .data(graphData.nodes)
      .join('circle')
      .attr('class', 'node')
      .attr('r', (d) => {
        if (d.title === '常天喆') return 25
        return Math.max(4, Math.min(18, 5 + (d.type === 'entity' ? 3 : d.type === 'concept' ? 2 : 1.5)))
      })
      .attr('fill', (d) => typeColors[d.type as keyof typeof typeColors] || '#6b7280')
      .attr('stroke', (d) => d.title === '常天喆' ? '#67e8f9' : '#fff')
      .attr('stroke-width', (d) => d.title === '常天喆' ? 4 : 2)
      .style('cursor', 'pointer')
      .style('filter', (d) => d.title === '常天喆' ? 'url(#glow-center)' : 'url(#glow)')

    const nodeFilter = defs.append('filter')
      .attr('id', 'glow')
    nodeFilter.append('feGaussianBlur')
      .attr('stdDeviation', '3')
      .attr('result', 'coloredBlur')
    const glowMerge = nodeFilter.append('feMerge')
    glowMerge.append('feMergeNode').attr('in', 'coloredBlur')
    glowMerge.append('feMergeNode').attr('in', 'SourceGraphic')

    const centerFilter = defs.append('filter')
      .attr('id', 'glow-center')
    centerFilter.append('feGaussianBlur')
      .attr('stdDeviation', '6')
      .attr('result', 'coloredBlur')
    const centerMerge = centerFilter.append('feMerge')
    centerMerge.append('feMergeNode').attr('in', 'coloredBlur')
    centerMerge.append('feMergeNode').attr('in', 'SourceGraphic')

    const stars = g.append('g')
      .selectAll('circle.star')
      .data(Array.from({ length: 200 }, (_, i) => ({
        id: `star-${i}`,
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.5 + 0.5,
        opacity: Math.random() * 0.5 + 0.3,
      })))
      .join('circle')
      .attr('class', 'star')
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y)
      .attr('r', (d) => d.r)
      .attr('fill', '#ffffff')
      .attr('opacity', (d) => d.opacity)

    const label = g.append('g')
      .selectAll('text')
      .data(graphData.nodes)
      .join('text')
      .attr('class', 'label')
      .attr('dy', -15)
      .attr('text-anchor', 'middle')
      .attr('fill', '#e2e8f0')
      .attr('font-size', (d) => d.title === '常天喆' ? '14px' : '11px')
      .attr('font-weight', (d) => d.title === '常天喆' ? '700' : '500')
      .text((d) => d.title.length > 25 ? d.title.substring(0, 25) + '...' : d.title)
      .style('pointer-events', 'none')
      .style('opacity', 0.95)
      .style('text-shadow', '0 2px 4px rgba(0,0,0,0.8)')

    node
      .on('mouseover', (event, d) => {
        d3.select(event.currentTarget)
          .transition()
          .duration(200)
          .attr('r', (d: any) => {
            if (d.title === '常天喆') return 32
            return Math.max(8, Math.min(25, 10 + (d.type === 'entity' ? 5 : d.type === 'concept' ? 4 : 3)))
          })
          .attr('stroke', '#67e8f9')
          .attr('stroke-width', (d: any) => d.title === '常天喆' ? 5 : 3)
        
        label.filter((l: any) => l.id === d.id)
          .transition()
          .duration(200)
          .attr('font-size', (l: any) => l.title === '常天喆' ? '16px' : '13px')
          .attr('opacity', 1)
      })
      .on('mouseout', (event, d) => {
        d3.select(event.currentTarget)
          .transition()
          .duration(200)
          .attr('r', (d: any) => {
            if (d.title === '常天喆') return 25
            return Math.max(4, Math.min(18, 5 + (d.type === 'entity' ? 3 : d.type === 'concept' ? 2 : 1.5)))
          })
          .attr('stroke', (d: any) => d.title === '常天喆' ? '#67e8f9' : '#fff')
          .attr('stroke-width', (d: any) => d.title === '常天喆' ? 4 : 2)
        
        label.filter((l: any) => l.id === d.id)
          .transition()
          .duration(200)
          .attr('font-size', (l: any) => l.title === '常天喆' ? '14px' : '11px')
          .attr('opacity', 0.95)
      })
      .on('click', (event, d) => {
        event.stopPropagation()
        setSelectedNode(d)
      })
      .call(d3.drag<SVGCircleElement, Node>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any)

    const simulation = d3.forceSimulation(graphData.nodes)
      .force('link', d3.forceLink(graphData.links).id((d: any) => d.id).distance((d: any) => {
        const sourceNode = typeof d.source === 'object' ? d.source : nodeMap.get(d.source as string)
        const targetNode = typeof d.target === 'object' ? d.target : nodeMap.get(d.target as string)
        if (sourceNode?.title === '常天喆' || targetNode?.title === '常天喆') {
          return 100
        }
        return 150
      }))
      .force('charge', d3.forceManyBody().strength((d: any) => d.title === '常天喆' ? -1000 : -300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d: any) => d.title === '常天喆' ? 50 : 25))
      .on('tick', ticked)

    simulationRef.current = simulation

    function ticked() {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y)

      node
        .attr('cx', (d) => d.x!)
        .attr('cy', (d) => d.y!)

      label
        .attr('x', (d) => d.x!)
        .attr('y', (d) => d.y!)
    }

    function dragstarted(event: any, d: Node) {
      if (d.title !== '常天喆') {
        if (!event.active) simulation.alphaTarget(0.3).restart()
        d.fx = d.x
        d.fy = d.y
      }
    }

    function dragged(event: any, d: Node) {
      if (d.title !== '常天喆') {
        d.fx = event.x
        d.fy = event.y
      }
    }

    function dragended(event: any, d: Node) {
      if (d.title !== '常天喆') {
        if (!event.active) simulation.alphaTarget(0)
        d.fx = null
        d.fy = null
      }
    }

    svg.on('click', () => {
      setSelectedNode(null)
    })

    const handleResize = () => {
      const newWidth = window.innerWidth
      const newHeight = window.innerHeight - 100
      simulation.force('center', d3.forceCenter(newWidth / 2, newHeight / 2))
      
      if (centerNode) {
        centerNode.fx = newWidth / 2
        centerNode.fy = newHeight / 2
      }
      
      stars.each((d: any) => {
        d.x = Math.random() * newWidth
        d.y = Math.random() * newHeight
      })
      stars
        .attr('cx', (d: any) => d.x)
        .attr('cy', (d: any) => d.y)
      
      simulation.alpha(0.3).restart()
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [graphData])

  function getGroupIndex(type: string): number {
    const groups = ['entity', 'concept', 'source', 'timeline', 'meta', 'exploration']
    return groups.indexOf(type)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="text-xl text-slate-300 animate-pulse">🌌 加载知识星图...</div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-screen bg-slate-950 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-cyan-900/20 via-slate-950 to-slate-950 pointer-events-none" />
      
      <div className="absolute top-4 left-4 z-10 bg-slate-900/80 backdrop-blur-xl rounded-2xl shadow-2xl p-5 border border-slate-700/50">
        <h1 className="text-2xl font-bold text-white mb-4">
          🌟 Chang&apos;s Wiki 知识星图
        </h1>
        <div className="space-y-2">
          {Object.entries(typeLabels).map(([type, label]) => (
            <div key={type} className="flex items-center gap-3 text-sm">
              <div 
                className="w-3.5 h-3.5 rounded-full shadow-lg"
                style={{ 
                  backgroundColor: typeColors[type as keyof typeof typeColors],
                  boxShadow: `0 0 10px ${typeColors[type as keyof typeof typeColors]}`
                }}
              />
              <span className="text-slate-300">{label}</span>
            </div>
          ))}
        </div>
        <div className="mt-5 pt-4 border-t border-slate-700/50 text-xs text-slate-400 space-y-1">
          <p>🖱️ 拖拽节点 · 滚轮缩放 · 点击查看详情</p>
          <p>⭐ 中心亮点：常天喆</p>
        </div>
      </div>

      <div className="absolute top-4 right-4 z-10 bg-slate-900/80 backdrop-blur-xl rounded-2xl shadow-2xl p-5 border border-slate-700/50">
        <div className="text-sm space-y-2">
          <p className="text-slate-300"><strong>✨ 节点数：</strong>{graphData?.nodes.length}</p>
          <p className="text-slate-300"><strong>🔗 链接数：</strong>{graphData?.links.length}</p>
        </div>
      </div>

      <svg 
        ref={svgRef}
        width="100%"
        height="100%"
        className="cursor-move"
      />

      <AnimatePresence>
        {selectedNode && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="absolute bottom-6 right-6 z-10 bg-slate-900/95 backdrop-blur-xl rounded-2xl shadow-2xl p-6 border border-slate-700/50 max-w-md"
          >
            <button
              onClick={() => setSelectedNode(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-200 transition-colors"
            >
              ✕
            </button>
            <h2 className="text-xl font-bold text-white mb-4">
              {selectedNode.title}
            </h2>
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-3">
                <span className="text-slate-400">类型：</span>
                <span className="inline-flex items-center gap-2">
                  <div 
                    className="w-2.5 h-2.5 rounded-full shadow-lg"
                    style={{ 
                      backgroundColor: typeColors[selectedNode.type as keyof typeof typeColors],
                      boxShadow: `0 0 8px ${typeColors[selectedNode.type as keyof typeof typeColors]}`
                    }}
                  />
                  <span className="text-slate-200">{typeLabels[selectedNode.type as keyof typeof typeLabels]}</span>
                </span>
              </p>
              {selectedNode.domain.length > 0 && (
                <p>
                  <span className="text-slate-400">领域：</span>
                  <span className="ml-2 flex flex-wrap gap-1.5">
                    {selectedNode.domain.map((d, i) => (
                      <span key={i} className="px-2.5 py-1 bg-slate-800 rounded-full text-slate-300 text-xs border border-slate-700">
                        {d}
                      </span>
                    ))}
                  </span>
                </p>
              )}
              <p className="text-slate-500 text-xs mt-4 pt-3 border-t border-slate-700/50">
                路径：{selectedNode.id}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
