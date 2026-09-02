/* ============================================================
   AURA Frontend — app.js
   Consumes AURA backend WebSocket state.
   No traffic logic lives here; presentation only.
   ============================================================ */

// ── Map Setup ────────────────────────────────────────────────
// Issue 1 & 2: Use public OSM tiles. No API key required.
// Readable basemap that shows roads, water, and city context.
const map = L.map('map', { zoomControl: false }).setView([9.98, 76.32], 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
}).addTo(map);

// ── State ────────────────────────────────────────────────────
let markers = {};       // junction_id → L.circleMarker
let edgeLines = [];     // graph edge polylines
let graphData = null;   // cached graph for coordinate lookups

// ── WebSocket ────────────────────────────────────────────────
const ws = new WebSocket(`ws://${window.location.host}`);

// Issue 8: Connection status is independent from data source.
ws.onopen = () => {
    document.getElementById('status').innerText = 'Connected';
    document.getElementById('status').classList.remove('text-error');
    document.getElementById('status').classList.add('text-on-surface');
    document.getElementById('status-icon').style.color = '#4edea3';
};

ws.onclose = () => {
    document.getElementById('status').innerText = 'Disconnected';
    document.getElementById('status').classList.remove('text-on-surface');
    document.getElementById('status').classList.add('text-error');
    document.getElementById('status-icon').style.color = '#ffb4ab';
};

// ── Message Handler ──────────────────────────────────────────
ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    // ── GRAPH_DATA ───────────────────────────────────────────
    if (msg.event === "GRAPH_DATA") {
        graphData = msg.data;
        const bounds = [];

        // Issue 6: Markers at exact graph.json coordinates
        msg.data.junctions.forEach(j => {
            const latlng = [j.lat, j.lng];
            bounds.push(latlng);

            const marker = L.circleMarker(latlng, {
                color: '#adc6ff',
                fillColor: '#10131a',
                radius: 10,
                weight: 3,
                fillOpacity: 0.9
            }).addTo(map);

            // Tooltip always visible with junction ID and name
            marker.bindTooltip(`${j.id} ${j.name}`, {
                permanent: true,
                direction: 'top',
                offset: [0, -12],
                className: 'junction-tooltip'
            });

            markers[j.id] = marker;
        });

        // Issue 4: Fit map to bounding box of all graph nodes
        if (bounds.length > 0) {
            map.fitBounds(bounds, { padding: [40, 40] });
        }

        // Issue 5: Draw graph edges using actual node coordinates
        if (msg.data.edges) {
            msg.data.edges.forEach(edge => {
                const fromJ = msg.data.junctions.find(j => j.id === edge.from);
                const toJ = msg.data.junctions.find(j => j.id === edge.to);
                if (fromJ && toJ) {
                    const line = L.polyline(
                        [[fromJ.lat, fromJ.lng], [toJ.lat, toJ.lng]],
                        { color: '#424754', weight: 3, opacity: 0.7, dashArray: '8, 4' }
                    ).addTo(map);
                    edgeLines.push(line);
                }
            });
        }
    }

    // ── SIMULATED_TRAFFIC_STATE ──────────────────────────────
    if (msg.event === "SIMULATED_TRAFFIC_STATE") {
        const list = document.getElementById('junctions-list');
        list.innerHTML = '';

        let globalAvgDelay = 0;
        let delayCount = 0;
        let globalMaxQueue = 0;
        let globalSpillbacks = 0;

        // Issue 7: Determine dominant data source from actual approach source_modes
        let sourceModeCounts = { LIVE: 0, REPLAY: 0, SIMULATED: 0 };

        // ── Green Wave Panel ─────────────────────────────────
        const gwContainer = document.getElementById('green-wave-panel');
        if (gwContainer) {
            let gwHtml = '';
            if (msg.data.green_wave) {
                for (const [jid, data] of Object.entries(msg.data.green_wave)) {
                    let color = data.state === 'GREEN' ? '#4edea3' : '#ffb4ab';
                    gwHtml += `
                    <div class="flex flex-col items-center justify-center p-2 border border-outline-variant rounded bg-surface-container-highest shrink-0">
                        <span class="text-label-caps font-bold text-on-surface">${jid}</span>
                        <span class="text-data-mono text-on-surface-variant">${data.offset}s</span>
                        <span class="text-[10px] font-bold" style="color: ${color}">${data.state}</span>
                    </div>`;
                }
            }
            gwContainer.innerHTML = gwHtml;
        }

        // ── Junction Cards ───────────────────────────────────
        msg.data.junctions.forEach(j => {
            // AURA aggregate metrics
            let auraMaxQ = 0, auraDelay = 0, auraCount = 0;
            let auraApps = '';
            for (const [appr, state] of Object.entries(j.aura.approaches)) {
                auraMaxQ = Math.max(auraMaxQ, state.max_queue_pcu);
                if (state.avg_delay_seconds > 0) {
                    auraDelay += state.avg_delay_seconds;
                    auraCount++;
                }

                // Issue 7: Count source modes for global label
                const sm = state.source_mode || 'SIMULATED';
                sourceModeCounts[sm] = (sourceModeCounts[sm] || 0) + 1;

                // Source badge per approach
                let sourceBadge = '';
                if (sm === 'LIVE') sourceBadge = `<span class="text-[10px] border border-secondary text-secondary rounded px-1 ml-2">LIVE</span>`;
                else if (sm === 'REPLAY') sourceBadge = `<span class="text-[10px] border border-tertiary text-tertiary rounded px-1 ml-2">REPLAY</span>`;
                else sourceBadge = `<span class="text-[10px] border border-outline-variant text-on-surface-variant rounded px-1 ml-2">SIM</span>`;

                let stateColor = state.signal_state === 'GREEN' ? 'text-secondary' : 'text-error';
                auraApps += `
                <div class="flex justify-between items-center text-body-sm py-1 border-b border-outline-variant border-opacity-30">
                    <div><strong class="text-on-surface">${appr}</strong> ${sourceBadge}</div>
                    <div class="text-right">
                        <span class="${stateColor} font-bold mr-2">${state.signal_state}</span>
                        <span class="text-on-surface-variant">${state.queue_pcu} PCU</span>
                    </div>
                </div>`;
            }
            let avgDelayJ = auraCount > 0 ? (auraDelay / auraCount) : 0;
            globalAvgDelay += avgDelayJ;
            if (auraCount > 0) delayCount++;
            globalMaxQueue = Math.max(globalMaxQueue, auraMaxQ);
            globalSpillbacks += j.aura.spillback_events;

            // BASELINE aggregate metrics
            let baseMaxQ = 0, baseDelay = 0, baseCount = 0;
            let baseApps = '';
            for (const [appr, state] of Object.entries(j.baseline.approaches)) {
                baseMaxQ = Math.max(baseMaxQ, state.max_queue_pcu);
                if (state.avg_delay_seconds > 0) {
                    baseDelay += state.avg_delay_seconds;
                    baseCount++;
                }
                let stateColor = state.signal_state === 'GREEN' ? 'text-secondary' : 'text-error';
                baseApps += `
                <div class="flex justify-between items-center text-body-sm py-1 border-b border-outline-variant border-opacity-30">
                    <div><strong class="text-on-surface">${appr}</strong></div>
                    <div class="text-right">
                        <span class="${stateColor} font-bold mr-2">${state.signal_state}</span>
                        <span class="text-on-surface-variant">${state.queue_pcu} PCU</span>
                    </div>
                </div>`;
            }
            let avgBaseDelayJ = baseCount > 0 ? (baseDelay / baseCount) : 0;

            // Junction Card
            const card = document.createElement('div');
            card.className = 'border border-outline-variant rounded bg-surface-container-lowest overflow-hidden shrink-0';

            let html = `
            <div class="bg-surface-container-low px-3 py-2 border-b border-outline-variant flex justify-between items-center">
                <span class="text-body-md font-bold text-on-surface">${j.junction_id} <span class="text-on-surface-variant font-normal">(Ph ${j.current_phase})</span></span>
                <span class="text-[10px] text-tertiary">BP: x${j.aura.back_pressure_multiplier.toFixed(2)}</span>
            </div>
            <div class="p-2 flex flex-col gap-2">
                <div class="bg-surface-container-highest p-2 rounded border border-outline-variant">
                    <div class="text-label-caps text-primary mb-1">AURA</div>
                    ${auraApps}
                    <div class="flex justify-between mt-2 text-[10px] text-on-surface-variant">
                        <span>Delay: ${avgDelayJ.toFixed(1)}s</span>
                        <span>Max Q: ${auraMaxQ.toFixed(1)}</span>
                        <span>Spillbacks: ${j.aura.spillback_events}</span>
                    </div>
                </div>
                <div class="bg-surface p-2 rounded border border-outline-variant opacity-70">
                    <div class="text-label-caps text-on-surface-variant mb-1">BASELINE</div>
                    ${baseApps}
                    <div class="flex justify-between mt-2 text-[10px] text-on-surface-variant">
                        <span>Delay: ${avgBaseDelayJ.toFixed(1)}s</span>
                        <span>Max Q: ${baseMaxQ.toFixed(1)}</span>
                        <span>Spillbacks: ${j.baseline.spillback_events}</span>
                    </div>
                </div>
            </div>`;

            card.innerHTML = html;
            list.appendChild(card);

            // Issue 6: Update marker color from actual signal state
            if (markers[j.junction_id]) {
                const nb = j.aura.approaches['NORTHBOUND'];
                if (nb) {
                    const activeColor = nb.signal_state === 'GREEN' ? '#4edea3' : '#ffb4ab';
                    markers[j.junction_id].setStyle({ color: activeColor });
                }
            }
        });

        // ── Top Metrics Bar ──────────────────────────────────
        let finalAvgDelay = delayCount > 0 ? (globalAvgDelay / delayCount).toFixed(1) : 0;
        document.getElementById('metric-delay').innerText = `${finalAvgDelay}s`;
        document.getElementById('metric-demand').innerText = `${globalMaxQueue.toFixed(1)} PCU`;
        document.getElementById('metric-spillbacks').innerText = `${globalSpillbacks}`;

        // Issue 7: Update global data source label from actual source modes
        let dominantSource = 'SIMULATED';
        if (sourceModeCounts.LIVE > 0) dominantSource = 'LIVE';
        else if (sourceModeCounts.REPLAY > 0) dominantSource = 'REPLAY';

        const dsEl = document.getElementById('data-source');
        if (dsEl) {
            dsEl.innerText = dominantSource;
            if (dominantSource === 'LIVE') {
                dsEl.className = 'text-data-mono font-data-mono text-secondary';
            } else if (dominantSource === 'REPLAY') {
                dsEl.className = 'text-data-mono font-data-mono text-tertiary';
            } else {
                dsEl.className = 'text-data-mono font-data-mono text-on-surface-variant';
            }
        }

        const sidebarLabel = document.getElementById('sidebar-data-label');
        if (sidebarLabel) {
            if (dominantSource === 'LIVE') sidebarLabel.innerText = 'Live Data Stream';
            else if (dominantSource === 'REPLAY') sidebarLabel.innerText = 'Replay Data';
            else sidebarLabel.innerText = 'Simulated Data';
        }
    }

    // ── ROUTE_RESULT ─────────────────────────────────────────
    if (msg.event === "ROUTE_RESULT") {
        const resDiv = document.getElementById('route-results');
        const d = msg.data;

        resDiv.innerHTML = `
            <div class="border border-error border-opacity-50 bg-error bg-opacity-10 rounded p-3">
                <h4 class="text-error font-bold text-body-md mb-1">Individual Fastest Route</h4>
                <div class="text-on-surface text-body-sm mb-1">${d.individual.route.join(' &rarr; ')}</div>
                <div class="flex justify-between text-on-surface-variant text-[11px] mb-2">
                    <span>${d.individual.distance}m</span>
                    <span>${Math.round(d.individual.estimatedTime)}s</span>
                    <span>Congestion: ${Math.round(d.individual.congestionExposure * 100)}%</span>
                </div>
                <p class="text-[10px] text-error opacity-80 italic">${d.individual.explanation}</p>
            </div>

            <div class="border border-secondary border-opacity-50 bg-secondary bg-opacity-10 rounded p-3">
                <h4 class="text-secondary font-bold text-body-md mb-1">AURA Cooperative Route</h4>
                <div class="text-on-surface text-body-sm mb-1">${d.aura.route.join(' &rarr; ')}</div>
                <div class="flex justify-between text-on-surface-variant text-[11px] mb-2">
                    <span>${d.aura.distance}m</span>
                    <span>${Math.round(d.aura.estimatedTime)}s</span>
                    <span>Congestion: ${Math.round(d.aura.congestionExposure * 100)}%</span>
                </div>
                <p class="text-[11px] text-secondary font-bold mt-1">${d.aura.explanation}</p>
            </div>
        `;

        // Clear old route lines
        if (window.routePolylines) {
            window.routePolylines.forEach(p => map.removeLayer(p));
        }
        window.routePolylines = [];

        // Issue 10: Route lines use exact graph node coordinates
        function drawPath(pathNodes, color, weight, dashArray, offsetLat, offsetLng) {
            let latlngs = pathNodes.map(id => {
                let ll = markers[id].getLatLng();
                return [ll.lat + offsetLat, ll.lng + offsetLng];
            });
            let polyline = L.polyline(latlngs, {
                color: color,
                weight: weight,
                dashArray: dashArray,
                opacity: 0.9
            }).addTo(map);
            window.routePolylines.push(polyline);
        }

        // Offset individual route slightly so both are visible
        drawPath(d.individual.route, '#ffb4ab', 4, '10, 10', 0.001, 0);
        drawPath(d.aura.route, '#4edea3', 6, null, -0.001, 0);
    }
};

// ── Route Request ────────────────────────────────────────────
function requestRoute() {
    const origin = document.getElementById('route-origin').value;
    const dest = document.getElementById('route-dest').value;
    ws.send(JSON.stringify({
        event: "ROUTE_REQUEST",
        data: { origin, destination: dest }
    }));
}
