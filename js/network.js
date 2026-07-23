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

  const width = () => Math.max(elements.stage.clientWidth, 320);
  const height = () => Math.max(elements.stage.clientHeight, 420);

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
      { label: `${minCount.toLocaleString()} links`, value: minCount },
      { label: `${midCount.toLocaleString()} links`, value: midCount },
      { label: `${maxCount.toLocaleString()} links`, value: maxCount },
    ];

    const withDistance = nodes.filter((node) => node.distance_km != null);
    let distanceSection = "";
    if (withDistance.length) {
      const distances = withDistance.map((node) => node.distance_km);
      const minDistance = Math.min(...distances);
      const maxDistance = Math.max(...distances);
      const midDistance = Math.round((minDistance + maxDistance) / 2);
      distanceSection = `
        <h3>Distance from Auckland</h3>
        <p>Shown in node details for geocoded affiliations.</p>
        <div class="legend-row"><span class="legend-line"></span><span>${formatDistance(minDistance)} – ${formatDistance(maxDistance)} across network</span></div>
        <div class="legend-row"><span class="legend-dot legend-dot-small"></span><span>Example: ${formatDistance(midDistance)}</span></div>
      `;
    }

    elements.legend.innerHTML = `
      <h3>Node size · co-authorship connections (log scale)</h3>
      <p>Circle area scales with shared-authorship links in the current view.</p>
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

  function renderBarChart(nodes) {
    if (!elements.barChart) return;
    const sorted = [...nodes].sort((a, b) => b.connections - a.connections).slice(0, 12);
    const maxConnections = sorted[0]?.connections || 1;
    const logScale = d3.scaleLog().domain([1, maxConnections]).range([0.08, 1]).clamp(true);

    elements.barChart.innerHTML = sorted
      .map((node) => {
        const widthPct = `${logScale(Math.max(1, node.connections)) * 100}%`;
        const selected = node.id === selectedNodeId;
        const dimmed = searchQuery && matchedNodeIds.size && !matchedNodeIds.has(node.id);
        return `
          <div class="bar-row${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}">
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
        <button type="button" class="result-item${node.id === selectedNodeId ? " selected" : ""}" data-node-id="${escapeHtml(node.id)}">
          <div class="affiliation">${escapeHtml(node.label)}</div>
          <div class="meta">${node.connections.toLocaleString()} connections${node.distance_km != null ? ` · ${formatDistance(node.distance_km)} from Auckland` : ""}${node.affiliation ? ` · ${escapeHtml(node.affiliation)}` : ""}</div>
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
    const nodes = graph.nodes;
    const links = graph.links;
    const radiusScale = buildRadiusScale(nodes);
    const centerX = width() / 2;
    const centerY = height() / 2;
    const searching = Boolean(searchQuery);

    elements.summary.textContent = `${nodes.length.toLocaleString()} nodes · ${links.length.toLocaleString()} co-authorship links · scroll to zoom, drag to pan`;

    const link = graphLayer
      .append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke", (d) => {
        if (!selectedNodeId) return "#94a3ad";
        const sourceId = typeof d.source === "object" ? d.source.id : d.source;
        const targetId = typeof d.target === "object" ? d.target.id : d.target;
        return sourceId === selectedNodeId || targetId === selectedNodeId
          ? "#1f6f8b"
          : "#94a3ad";
      })
      .attr("stroke-opacity", (d) => {
        if (!selectedNodeId) return 0.35;
        const sourceId = typeof d.source === "object" ? d.source.id : d.source;
        const targetId = typeof d.target === "object" ? d.target.id : d.target;
        return sourceId === selectedNodeId || targetId === selectedNodeId ? 0.9 : 0.07;
      })
      .attr("stroke-width", (d) => {
        const base = Math.max(0.8, Math.log2(d.weight + 1));
        if (!selectedNodeId) return base;
        const sourceId = typeof d.source === "object" ? d.source.id : d.source;
        const targetId = typeof d.target === "object" ? d.target.id : d.target;
        return sourceId === selectedNodeId || targetId === selectedNodeId ? base + 1.5 : base;
      });

    const node = graphLayer
      .append("g")
      .selectAll("circle")
      .data(nodes)
      .join("circle")
      .attr("r", (d) => radiusScale(Math.max(1, d.connections)))
      .attr("fill", (d) => {
        if (d.id === selectedNodeId) return "#1f6f8b";
        if (searching && matchedNodeIds.has(d.id)) return "#d95f02";
        return "#d95f02";
      })
      .attr("stroke", "#ffffff")
      .attr("stroke-width", (d) => (searching && matchedNodeIds.has(d.id) ? 2.5 : 1.5))
      .attr("opacity", (d) => {
        if (d.id === selectedNodeId) return 1;
        if (searching && matchedNodeIds.size) {
          return matchedNodeIds.has(d.id) ? 0.95 : 0.14;
        }
        if (selectedNodeId && d.id !== selectedNodeId) return 0.28;
        return 0.88;
      })
      .style("cursor", "pointer")
      .on("mouseenter", (_, d) => showNodeCard(d))
      .on("click", (_, d) => selectNode(d.id, { focus: false }));

    const label = graphLayer
      .append("g")
      .selectAll("text")
      .data(
        nodes.filter(
          (node) =>
            node.id === selectedNodeId ||
            (searchQuery && matchedNodeIds.has(node.id)) ||
            (!searchQuery && node.connections >= 20)
        )
      )
      .join("text")
      .attr("font-size", 10)
      .attr("fill", "#14212b")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => -radiusScale(Math.max(1, d.connections)) - 4)
      .text((d) => (d.label.length > 28 ? `${d.label.slice(0, 26)}…` : d.label));

    simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(90)
          .strength(0.45)
      )
      .force("charge", d3.forceManyBody().strength(-180))
      .force("center", d3.forceCenter(centerX, centerY))
      .force("collide", d3.forceCollide().radius((d) => radiusScale(Math.max(1, d.connections)) + 4))
      .on("tick", () => {
        link
          .attr("x1", (d) => d.source.x)
          .attr("y1", (d) => d.source.y)
          .attr("x2", (d) => d.target.x)
          .attr("y2", (d) => d.target.y);
        node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
        label.attr("x", (d) => d.x).attr("y", (d) => d.y);
      });

    node.call(nodeDrag());
    renderLegend(nodes, radiusScale);
    renderBarChart(nodes);
    renderSearchResults(nodes);
    hasRendered = true;
  }

  function nodeDrag() {
    return d3
      .drag()
      .on("start", (event, d) => {
        event.sourceEvent?.stopPropagation?.();
        if (!event.active && simulation) simulation.alphaTarget(0.25).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        const transform = d3.zoomTransform(svg.node());
        d.fx = (event.x - transform.x) / transform.k;
        d.fy = (event.y - transform.y) / transform.k;
      })
      .on("end", (event, d) => {
        if (!event.active && simulation) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
  }

  function showNodeCard(node) {
    elements.card.hidden = false;
    elements.cardTitle.textContent = node.label;
    const parts = [
      `${node.connections.toLocaleString()} shared-authorship connection${node.connections === 1 ? "" : "s"}`,
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
    const graph = prepareGraph();
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node || node.x == null || node.y == null) return;

    const scale = 2.2;
    const transform = d3.zoomIdentity
      .translate(width() / 2, height() / 2)
      .scale(scale)
      .translate(-node.x, -node.y);
    svg.transition().duration(450).call(zoom.transform, transform);
  }

  function selectNode(nodeId, { focus = false } = {}) {
    selectedNodeId = selectedNodeId === nodeId ? null : nodeId;
    const node = selectedNodeId ? currentGraph().nodes.find((item) => item.id === selectedNodeId) : null;
    if (node) {
      showNodeCard(node);
    } else {
      elements.card.hidden = true;
    }
    renderGraph();
    if (focus && selectedNodeId) focusNode(selectedNodeId);
  }

  function applySearch(query, { focus = true } = {}) {
    updateMatches(query);
    selectedNodeId = null;
    elements.card.hidden = true;

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
      const firstMatch = prepareGraph().nodes.find((node) => matchedNodeIds.has(node.id));
      if (firstMatch) {
        setTimeout(() => selectNode(firstMatch.id, { focus: true }), 300);
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
        detail: `${node.connections.toLocaleString()} connections${node.distance_km != null ? ` · ${formatDistance(node.distance_km)}` : ""}${node.affiliation ? ` · ${node.affiliation}` : ""}`,
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

  if (elements.resetZoom) {
    elements.resetZoom.addEventListener("click", resetZoom);
  }

  return {
    setMode,
    resize,
    resetZoom,
    applySearch,
    buildSuggestions,
    selectNode,
  };
}
