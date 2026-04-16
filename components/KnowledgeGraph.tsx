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
}

interface Link {
  source: string
  target: string
  value: number
}

interface GraphData {
  nodes: Node[]
  links: Link[]
}

const typeColors = {
  entity: '#3b82f6',
  concept: '#8b5cf6',
  source: '#ec4899',
  timeline: '#f59e0b',
  meta: '#6b7280',
  exploration: '#10b981',
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
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
      })

    svg.call(zoom)

    const link = g.append('g')
      .selectAll('line')
      .data(graphData.links)
      .join('line')
      .attr('class', 'link')
      .attr('stroke', '#94a3b8')
      .attr('stroke-opacity', 0.4)
      .attr('stroke-width', 1)

    const node = g.append('g')
      .selectAll('circle')
      .data(graphData.nodes)
      .join('circle')
      .attr('class', 'node')
      .attr('r', (d) => Math.max(5, Math.min(20, 6 + (d.type === 'entity' ? 4 : d.type === 'concept' ? 3 : 2))))
      .attr('fill', (d) => typeColors[d.type as keyof typeof typeColors] || '#6b7280')
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)
      .style('cursor', 'pointer')
      .on('mouseover', (event, d) => {
        d3.select(event.currentTarget)
          .transition()
          .duration(200)
          .attr('r', (d) => Math.max(10, Math.min(30, 12 + (d.type === 'entity' ? 6 : d.type === 'concept' ? 4 : 3))))
          .attr('stroke', '#fbbf24')
          .attr('stroke-width', 3)
      })
      .on('mouseout', (event, d) => {
        d3.select(event.currentTarget)
          .transition()
          .duration(200)
          .attr('r', (d) => Math.max(5, Math.min(20, 6 + (d.type === 'entity' ? 4 : d.type === 'concept' ? 3 : 2))))
          .attr('stroke', '#fff')
          .attr('stroke-width', 2)
      })
      .on('click', (event, d) => {
        event.stopPropagation()
        setSelectedNode(d)
      })
      .call(d3.drag<SVGCircleElement, Node>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended))

    const label = g.append('g')
      .selectAll('text')
      .data(graphData.nodes)
      .join('text')
      .attr('class', 'label')
      .attr('dy', -12)
      .attr('text-anchor', 'middle')
      .attr('fill', '#1e293b')
      .attr('font-size', '10px')
      .attr('font-weight', '500')
      .text((d) => d.title.length > 20 ? d.title.substring(0, 20) + '...' : d.title)
      .style('pointer-events', 'none')
      .style('opacity', 0.85)

    const simulation = d3.forceSimulation(graphData.nodes)
      .force('link', d3.forceLink(graphData.links).id((d: any) => d.id).distance(120))
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(30))
      .on('tick', ticked)

    simulationRef.current = simulation

    function ticked() {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y)

      node
        .attr('cx', (d) => d.x)
        .attr('cy', (d) => d.y)

      label
        .attr('x', (d) => d.x)
        .attr('y', (d) => d.y)
    }

    function dragstarted(event: any, d: Node) {
      if (!event.active) simulation.alphaTarget(0.3).restart()
      d.fx = d.x
      d.fy = d.y
    }

    function dragged(event: any, d: Node) {
      d.fx = event.x
      d.fy = event.y
    }

    function dragended(event: any, d: Node) {
      if (!event.active) simulation.alphaTarget(0)
      d.fx = null
      d.fy = null
    }

    svg.on('click', () => {
      setSelectedNode(null)
    })

    const handleResize = () => {
      const newWidth = window.innerWidth
      const newHeight = window.innerHeight - 100
      simulation.force('center', d3.forceCenter(newWidth / 2, newHeight / 2))
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
      <div className="flex items-center justify-center h-screen">
        <div className="text-xl text-gray-600">加载中...</div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-purple-50">
      <div className="absolute top-4 left-4 z-10 bg-white/90 backdrop-blur-sm rounded-xl shadow-lg p-4 border border-slate-200">
        <h1 className="text-2xl font-bold text-slate-800 mb-3">Chang&apos;s Wiki Knowledge Graph</h1>
        <div className="space-y-2">
          {Object.entries(typeLabels).map(([type, label]) => (
            <div key={type} className="flex items-center gap-2 text-sm">
              <div 
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: typeColors[type as keyof typeof typeColors] }}
              />
              <span className="text-slate-600">{label}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 pt-4 border-t border-slate-200 text-xs text-slate-500">
          <p>🖱️ 拖拽节点 · 滚轮缩放 · 点击查看详情</p>
        </div>
      </div>

      <div className="absolute top-4 right-4 z-10 bg-white/90 backdrop-blur-sm rounded-xl shadow-lg p-4 border border-slate-200">
        <div className="text-sm space-y-1">
          <p className="text-slate-700"><strong>节点数：</strong>{graphData?.nodes.length}</p>
          <p className="text-slate-700"><strong>链接数：</strong>{graphData?.links.length}</p>
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
            className="absolute bottom-4 right-4 z-10 bg-white/95 backdrop-blur-sm rounded-xl shadow-xl p-6 border border-slate-200 max-w-md"
          >
            <button
              onClick={() => setSelectedNode(null)}
              className="absolute top-3 right-3 text-slate-400 hover:text-slate-600"
            >
              ✕
            </button>
            <h2 className="text-xl font-bold text-slate-800 mb-3">{selectedNode.title}</h2>
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-slate-500">类型：</span>
                <span className="ml-2 inline-flex items-center gap-2">
                  <div 
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: typeColors[selectedNode.type as keyof typeof typeColors] }}
                  />
                  {typeLabels[selectedNode.type as keyof typeof typeLabels]}
                </span>
              </p>
              {selectedNode.domain.length > 0 && (
                <p>
                  <span className="text-slate-500">领域：</span>
                  <span className="ml-2 flex flex-wrap gap-1">
                    {selectedNode.domain.map((d, i) => (
                      <span key={i} className="px-2 py-0.5 bg-slate-100 rounded text-slate-600 text-xs">
                        {d}
                      </span>
                    ))}
                  </span>
                </p>
              )}
              <p className="text-slate-500 text-xs mt-4">
                路径：{selectedNode.id}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
