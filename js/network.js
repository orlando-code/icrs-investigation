import { escapeHtml, formatDistance } from "./utils.js";

const MAX_NODES = 180;

export function createNetworkView(siteData, elements) {
  const network = siteData.network;
  let mode = "individual";
  let selectedNodeId = null;
  let searchQuery = "";
  let matchedNodeIds = new Set();
  let simulation = null;
  let hasRendered = false;
  let graphNodes = [];
  let graphLinks = [];
  let radiusScale = null;
  let linkSelection = null;
  let nodeSelection = null;
  let labelSelection = null;
  let dragMoved = false;
  const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const canvasEl =
    elements.stage?.querySelector?.(".network-stage-canvas") || elements.stage;

  const width = () => Math.max(canvasEl.clientWidth, 320);
  const height = () => Math.max(canvasEl.clientHeight, 280);

  const svg = d3.select(elements.networkSvg);
  const defs = svg.append("defs");
  defs
    .append("clipPath")
    .attr("id", "network-graph-clip")
    .append("rect")
    .attr("x", 0)
    .attr("y", 0);

  const viewport = svg.append("g").attr("class", "viewport");
  const graphLayer = viewport.append("g").attr("class", "graph-layer");

  const zoom = d3
    .zoom()
    .scaleExtent([0.15, 10])
    .filter((event) => {
      if (event.type === "wheel") return true;
      if (event.type.startsWith("touch") && event.touches?.length > 1) return true;
      const target = event.target;
      return target === svg.node() || target?.nodeName === "svg";
    })
    .on("zoom", (event) => {
      viewport.attr("transform", event.transform);
    });

  svg.call(zoom).on("dblclick.zoom", null);

  function currentGraph() {
    return network[mode];
  }

  function nodeMatchesSearch(node, query) {
    const q = query.toLowerCase();
    if (node.label.toLowerCase().includes(q)) return true;
    if (mode === "individual" && node.affiliation?.toLowerCase().includes(q)) return true;
    return false;
  }

  function updateMatches(query) {
    searchQuery = query.trim();
    matchedNodeIds = new Set();
    if (!searchQuery) return matchedNodeIds;

    const graph = currentGraph();
    for (const node of graph.nodes) {
      if (nodeMatchesSearch(node, searchQuery)) {
        matchedNodeIds.add(node.id);
      }
    }
    return matchedNodeIds;
  }

  function prepareGraph() {
    const graph = currentGraph();
    const nodesById = new Map(graph.nodes.map((node) => [node.id, { ...node }]));
    let links = graph.links
      .filter((link) => nodesById.has(link.source) && nodesById.has(link.target))
      .map((link) => ({ ...link }));

    let nodes = [...nodesById.values()];

    if (searchQuery && matchedNodeIds.size) {
      const visibleIds = new Set(matchedNodeIds);
      for (const link of links) {
        if (visibleIds.has(link.source)) visibleIds.add(link.target);
        if (visibleIds.has(link.target)) visibleIds.add(link.source);
      }
      nodes = nodes.filter((node) => visibleIds.has(node.id));
      links = links.filter(
        (link) => visibleIds.has(link.source) && visibleIds.has(link.target)
      );
    } else {
      nodes.sort((a, b) => b.connections - a.connections || a.label.localeCompare(b.label));
      if (nodes.length > MAX_NODES) {
        const keep = new Set(nodes.slice(0, MAX_NODES).map((node) => node.id));
        nodes = nodes.filter((node) => keep.has(node.id));
        links = links.filter((link) => keep.has(link.source) && keep.has(link.target));
      }
    }

    return { nodes, links };
  }

  function buildRadiusScale(nodes) {
    const counts = nodes.map((node) => Math.max(1, node.connections));
    const minCount = Math.max(1, d3.min(counts));
    const maxCount = Math.max(minCount + 1, d3.max(counts));
    return d3.scaleLog().domain([minCount, maxCount]).range([4, 26]).clamp(true);
  }

  function renderLegend(nodes, radiusScale) {
    if (!elements.legend) return;
    const counts = nodes.map((node) => node.connections);
    const minCount = Math.max(1, d3.min(counts) || 1);
    const maxCount = Math.max(minCount, d3.max(counts) || 1);
    const midCount = Math.round(Math.sqrt(minCount * maxCount));
    const samples = [
      { label: `${minCount.toLocaleString()} talks`, value: minCount },
      { label: `${midCount.toLocaleString()} talks`, value: midCount },
      { label: `${maxCount.toLocaleString()} talks`, value: maxCount },
    ];

    const withDistance = nodes.filter((node) => node.distance_km != null);
    let distanceSection = "";
    // if (withDistance.length) {
    //   const distances = withDistance.map((node) => node.distance_km);
    //   const minDistance = Math.min(...distances);
    //   const maxDistance = Math.max(...distances);
    //   const midDistance = Math.round((minDistance + maxDistance) / 2);
    //   distanceSection = `
    //     <h3>Distance from Auckland</h3>
    //     <p>Shown in node details for geocoded affiliations.</p>
    //     <div class="legend-row"><span class="legend-line"></span><span>${formatDistance(minDistance)} – ${formatDistance(maxDistance)} across network</span></div>
    //     <div class="legend-row"><span class="legend-dot legend-dot-small"></span><span>Example: ${formatDistance(midDistance)}</span></div>
    //   `;
    // }

    elements.legend.innerHTML = `
      <h3>Node size · talks on author lists (log scale)</h3>
      <p>Circle area scales with talks where the person or affiliation appears on the author list.</p>
      ${samples
        .map(
          (sample) => `
        <div class="legend-row">
          <span class="legend-dot" style="width:${radiusScale(sample.value) * 2}px;height:${radiusScale(sample.value) * 2}px"></span>
          <span>${sample.label}</span>
        </div>`
        )
        .join("")}
      ${distanceSection}
    `;
  }

  function neighborIds(nodeId) {
    const ids = new Set();
    if (!nodeId) return ids;
    for (const link of graphLinks) {
      const sourceId = typeof link.source === "object" ? link.source.id : link.source;
      const targetId = typeof link.target === "object" ? link.target.id : link.target;
      if (sourceId === nodeId) ids.add(targetId);
      if (targetId === nodeId) ids.add(sourceId);
    }
    return ids;
  }

  function labelNodes(nodes) {
    const searching = Boolean(searchQuery);
    const neighbors = neighborIds(selectedNodeId);
    return nodes.filter((node) => {
      if (node.id === selectedNodeId) return true;
      if (selectedNodeId && neighbors.has(node.id)) return true;
      if (searching && matchedNodeIds.has(node.id)) return true;
      if (!searchQuery && !selectedNodeId && node.connections >= 20) return true;
      return false;
    });
  }

  function linkEndpointIds(link) {
    return {
      sourceId: typeof link.source === "object" ? link.source.id : link.source,
      targetId: typeof link.target === "object" ? link.target.id : link.target,
    };
  }

  function linkIsHighlighted(link) {
    if (!selectedNodeId) return false;
    const { sourceId, targetId } = linkEndpointIds(link);
    return sourceId === selectedNodeId || targetId === selectedNodeId;
  }

  function updateSelectionUi() {
    const node = selectedNodeId
      ? currentGraph().nodes.find((item) => item.id === selectedNodeId)
      : null;

    if (node) {
      showNodeCard(node);
      if (elements.selectionLabel) elements.selectionLabel.textContent = node.label;
      elements.selectionBadge?.removeAttribute("hidden");
      elements.clearSelection?.removeAttribute("hidden");
    } else {
      elements.card.hidden = true;
      elements.selectionBadge?.setAttribute("hidden", "");
      elements.clearSelection?.setAttribute("hidden", "");
    }

    elements.summary.textContent = selectedNodeId
      ? `${graphNodes.length.toLocaleString()} nodes · tap background or Clear to deselect`
      : `${graphNodes.length.toLocaleString()} nodes · ${graphLinks.length.toLocaleString()} co-authorship links · ${isCoarsePointer ? "pinch to zoom, drag background to pan" : "scroll to zoom, drag to pan"}`;
  }

  function scrollToSelectedSidebar() {
    if (!selectedNodeId) return;
    const selector = `[data-node-id="${CSS.escape(selectedNodeId)}"]`;
    const target =
      elements.barChart?.querySelector(selector) ||
      elements.results?.querySelector(selector);
    target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function updateHighlight() {
    if (!nodeSelection || !linkSelection || !radiusScale) return;

    const searching = Boolean(searchQuery);
    const neighbors = neighborIds(selectedNodeId);

    linkSelection
      .attr("stroke", (d) => (linkIsHighlighted(d) ? "#1f6f8b" : "#94a3ad"))
      .attr("stroke-opacity", (d) => {
        if (!selectedNodeId) return 0.35;
        return linkIsHighlighted(d) ? 0.92 : 0.07;
      })
      .attr("stroke-width", (d) => {
        const base = Math.max(0.8, Math.log2(d.weight + 1));
        return linkIsHighlighted(d) ? base + 1.5 : base;
      });

    nodeSelection
      .attr("fill", (d) => {
        if (d.id === selectedNodeId) return "#1f6f8b";
        if (selectedNodeId && neighbors.has(d.id)) return "#4a90a7";
        if (searching && matchedNodeIds.has(d.id)) return "#d95f02";
        return "#d95f02";
      })
      .attr("stroke-width", (d) => {
        if (d.id === selectedNodeId) return 3;
        if (selectedNodeId && neighbors.has(d.id)) return 2.5;
        if (searching && matchedNodeIds.has(d.id)) return 2.5;
        return 1.5;
      })
      .attr("opacity", (d) => {
        if (d.id === selectedNodeId) return 1;
        if (selectedNodeId) {
          return neighbors.has(d.id) ? 0.95 : 0.16;
        }
        if (searching && matchedNodeIds.size) {
          return matchedNodeIds.has(d.id) ? 0.95 : 0.14;
        }
        return 0.88;
      });

    const labels = labelNodes(graphNodes);
    labelSelection = labelSelection.data(labels, (d) => d.id);
    labelSelection.exit().remove();
    const labelEnter = labelSelection
      .enter()
      .append("text")
      .attr("text-anchor", "middle")
      .attr("pointer-events", "none");
    labelSelection = labelEnter.merge(labelSelection);
    labelSelection
      .attr("font-size", (d) => (d.id === selectedNodeId ? 12 : 10))
      .attr("font-weight", (d) =>
        d.id === selectedNodeId ? 700 : neighbors.has(d.id) ? 600 : 500
      )
      .attr("fill", (d) => {
        if (d.id === selectedNodeId) return "#1f6f8b";
        if (neighbors.has(d.id)) return "#14212b";
        return "#14212b";
      })
      .attr("dy", (d) => -radiusScale(Math.max(1, d.connections)) - (d.id === selectedNodeId ? 6 : 4))
      .text((d) => (d.label.length > 28 ? `${d.label.slice(0, 26)}…` : d.label))
      .attr("x", (d) => d.x)
      .attr("y", (d) => d.y);

    renderBarChart(graphNodes);
    renderSearchResults(graphNodes);
    updateSelectionUi();
    scrollToSelectedSidebar();
  }

  function renderBarChart(nodes) {
    if (!elements.barChart) return;
    const sorted = [...nodes].sort((a, b) => b.connections - a.connections).slice(0, 12);
    const maxConnections = sorted[0]?.connections || 1;
    const logScale = d3.scaleLog().domain([1, maxConnections]).range([0.08, 1]).clamp(true);
    const neighbors = neighborIds(selectedNodeId);

    elements.barChart.innerHTML = sorted
      .map((node) => {
        const widthPct = `${logScale(Math.max(1, node.connections)) * 100}%`;
        const selected = node.id === selectedNodeId;
        const neighbor = selectedNodeId && neighbors.has(node.id);
        const dimmed =
          (searchQuery && matchedNodeIds.size && !matchedNodeIds.has(node.id)) ||
          (selectedNodeId && !selected && !neighbor);
        return `
          <div class="bar-row${selected ? " selected" : ""}${neighbor ? " neighbor" : ""}${dimmed ? " dimmed" : ""}">
            <button type="button" data-node-id="${escapeHtml(node.id)}">${escapeHtml(node.label)}</button>
            <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${widthPct}"></div></div>
            <span class="bar-count">${node.connections.toLocaleString()}</span>
          </div>`;
      })
      .join("");

    elements.barChart.querySelectorAll("[data-node-id]").forEach((button) => {
      button.addEventListener("click", () => selectNode(button.dataset.nodeId, { focus: true }));
    });
  }

  function renderSearchResults(nodes) {
    if (!elements.results || !elements.resultsTitle) return;
    const searching = Boolean(searchQuery);

    if (!searching) {
      elements.resultsTitle.textContent = "Search matches";
      elements.results.innerHTML = `<p class="status">Search to highlight nodes and their co-authors.</p>`;
      return;
    }

    const matches = nodes.filter((node) => matchedNodeIds.has(node.id));
    const neighbors = neighborIds(selectedNodeId);
    elements.resultsTitle.textContent = `${matches.length.toLocaleString()} matching node${matches.length === 1 ? "" : "s"}`;

    if (!matches.length) {
      elements.results.innerHTML = `<p class="status">No nodes match that search.</p>`;
      return;
    }

    elements.results.innerHTML = matches
      .sort((a, b) => b.connections - a.connections || a.label.localeCompare(b.label))
      .slice(0, 30)
      .map(
        (node) => `
        <button type="button" class="result-item${node.id === selectedNodeId ? " selected" : ""}${selectedNodeId && neighbors.has(node.id) ? " neighbor" : ""}" data-node-id="${escapeHtml(node.id)}">
          <div class="affiliation">${escapeHtml(node.label)}</div>
          <div class="meta">${node.connections.toLocaleString()} talk${node.connections === 1 ? "" : "s"} on author list${node.distance_km != null ? ` · ${formatDistance(node.distance_km)} from Auckland` : ""}${node.affiliation ? ` · ${escapeHtml(node.affiliation)}` : ""}</div>
        </button>`
      )
      .join("");

    elements.results.querySelectorAll("[data-node-id]").forEach((button) => {
      button.addEventListener("click", () => selectNode(button.dataset.nodeId, { focus: true }));
    });
  }

  function setSearchStatus(message, isError = false) {
    if (!elements.searchStatus) return;
    elements.searchStatus.textContent = message || "";
    elements.searchStatus.classList.toggle("error", isError);
  }

  function renderGraph() {
    graphLayer.selectAll("*").remove();
    if (simulation) simulation.stop();

    updateDimensions();
    const graph = prepareGraph();
    graphNodes = graph.nodes;
    graphLinks = graph.links;
    radiusScale = buildRadiusScale(graphNodes);
    const centerX = width() / 2;
    const centerY = height() / 2;

    linkSelection = graphLayer
      .append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(graphLinks)
      .join("line");

    nodeSelection = graphLayer
      .append("g")
      .attr("class", "nodes")
      .selectAll("circle")
      .data(graphNodes)
      .join("circle")
      .attr("r", (d) => {
        const base = radiusScale(Math.max(1, d.connections));
        return isCoarsePointer ? base + 4 : base;
      })
      .attr("stroke", "#ffffff")
      .style("cursor", "pointer")
      .style("touch-action", "none")
      .on("pointerenter", (_, d) => {
        if (!isCoarsePointer) showNodeCard(d);
      })
      .call(nodeDrag());

    labelSelection = graphLayer.append("g").attr("class", "labels").selectAll("text").data([]).join("text");

    simulation = d3
      .forceSimulation(graphNodes)
      .force(
        "link",
        d3
          .forceLink(graphLinks)
          .id((d) => d.id)
          .distance(90)
          .strength(0.45)
      )
      .force("charge", d3.forceManyBody().strength(isCoarsePointer ? -140 : -180))
      .force("center", d3.forceCenter(centerX, centerY))
      .force(
        "collide",
        d3.forceCollide().radius((d) => radiusScale(Math.max(1, d.connections)) + (isCoarsePointer ? 8 : 4))
      )
      .on("tick", () => {
        linkSelection
          .attr("x1", (d) => d.source.x)
          .attr("y1", (d) => d.source.y)
          .attr("x2", (d) => d.target.x)
          .attr("y2", (d) => d.target.y);
        nodeSelection.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
        if (labelSelection) {
          labelSelection.attr("x", (d) => d.x).attr("y", (d) => d.y);
        }
      });

    renderLegend(graphNodes, radiusScale);
    updateHighlight();
    hasRendered = true;
  }

  function nodeDrag() {
    return d3
      .drag()
      .touchable(true)
      .clickDistance(isCoarsePointer ? 12 : 4)
      .on("start", (event, d) => {
        event.sourceEvent?.stopPropagation?.();
        dragMoved = false;
        if (!event.active && simulation) simulation.alphaTarget(0.25).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        dragMoved = dragMoved || Math.abs(event.dx) > 1 || Math.abs(event.dy) > 1;
        const transform = d3.zoomTransform(svg.node());
        d.fx = (event.x - transform.x) / transform.k;
        d.fy = (event.y - transform.y) / transform.k;
      })
      .on("end", (event, d) => {
        if (!event.active && simulation) simulation.alphaTarget(0);
        if (!dragMoved) {
          selectNode(d.id, { focus: isCoarsePointer });
        }
        d.fx = null;
        d.fy = null;
      });
  }

  function showNodeCard(node) {
    elements.card.hidden = false;
    elements.cardTitle.textContent = node.label;
    const parts = [
      `${node.connections.toLocaleString()} talk${node.connections === 1 ? "" : "s"} on author list`,
    ];
    if (node.distance_km != null) {
      parts.push(`${formatDistance(node.distance_km)} from Auckland`);
    }
    if (mode === "individual" && node.affiliation) {
      parts.push(node.affiliation);
    }
    elements.cardMeta.textContent = parts.join(" · ");
  }

  function focusNode(nodeId) {
    const node = graphNodes.find((item) => item.id === nodeId);
    if (!node || node.x == null || node.y == null) return;

    const scale = isCoarsePointer ? 1.8 : 2.2;
    const transform = d3.zoomIdentity
      .translate(width() / 2, height() / 2)
      .scale(scale)
      .translate(-node.x, -node.y);
    svg.transition().duration(450).call(zoom.transform, transform);
  }

  function clearSelection() {
    selectedNodeId = null;
    updateHighlight();
  }

  function selectNode(nodeId, { focus = false } = {}) {
    selectedNodeId = nodeId;
    updateHighlight();
    if (focus && selectedNodeId) {
      window.requestAnimationFrame(() => focusNode(selectedNodeId));
    }
  }

  function applySearch(query, { focus = true } = {}) {
    updateMatches(query);
    selectedNodeId = null;

    if (!searchQuery) {
      setSearchStatus("");
      resetZoom();
      renderGraph();
      return;
    }

    if (!matchedNodeIds.size) {
      setSearchStatus("No nodes matched that search.", true);
      renderGraph();
      return;
    }

    setSearchStatus(
      `${matchedNodeIds.size.toLocaleString()} node${matchedNodeIds.size === 1 ? "" : "s"} matched (showing matches + co-authors)`
    );
    renderGraph();

    if (focus) {
      const firstMatch = graphNodes.find((node) => matchedNodeIds.has(node.id));
      if (firstMatch) {
        window.setTimeout(() => selectNode(firstMatch.id, { focus: true }), 300);
      }
    }
  }

  function buildSuggestions(query) {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length < 2) return [];

    return currentGraph()
      .nodes.filter((node) => nodeMatchesSearch(node, trimmed))
      .sort((a, b) => b.connections - a.connections)
      .slice(0, 8)
      .map((node) => ({
        label: node.label,
        detail: `${node.connections.toLocaleString()} talk${node.connections === 1 ? "" : "s"} on author list${node.distance_km != null ? ` · ${formatDistance(node.distance_km)}` : ""}${node.affiliation ? ` · ${node.affiliation}` : ""}`,
        query: node.label,
        nodeId: node.id,
      }));
  }

  function setMode(nextMode) {
    mode = nextMode;
    selectedNodeId = null;
    searchQuery = "";
    matchedNodeIds = new Set();
    elements.card.hidden = true;
    if (elements.searchInput) elements.searchInput.value = "";
    setSearchStatus("");
    resetZoom();
    renderGraph();
  }

  function resetView() {
    clearSelection();
    resetZoom();
  }

  function resetZoom() {
    svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity);
  }

  function updateDimensions() {
    const w = width();
    const h = height();
    svg.attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h);
    svg
      .select("#network-graph-clip rect")
      .attr("width", w)
      .attr("height", h);
    graphLayer.attr("clip-path", "url(#network-graph-clip)");
  }

  function resize() {
    updateDimensions();
    if (!hasRendered) resetZoom();
    renderGraph();
  }

  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", (event) => {
    if (event.target === svg.node() || event.target?.nodeName === "svg") {
      clearSelection();
    }
  });

  if (elements.resetZoom) {
    elements.resetZoom.addEventListener("click", resetView);
  }
  if (elements.clearSelection) {
    elements.clearSelection.addEventListener("click", clearSelection);
  }
  if (elements.clearSelectionMobile) {
    elements.clearSelectionMobile.addEventListener("click", clearSelection);
  }

  return {
    setMode,
    resize,
    resetZoom,
    clearSelection,
    applySearch,
    buildSuggestions,
    selectNode,
  };
}
