
const map = L.map('map', { zoomControl: false }).setView([9.98, 76.31], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap',
    subdomains: 'abcd',
    maxZoom: 20
}).addTo(map);

let markers = {};

const ws = new WebSocket(`ws://${window.location.host}`);

ws.onopen = () => {
    document.getElementById('status').innerText = 'Connected';
    document.getElementById('status-icon').style.color = '#4edea3'; // Secondary green
    document.getElementById('status').style.color = '#e1e2ec';
};

ws.onclose = () => {
    document.getElementById('status').innerText = 'Disconnected';
    document.getElementById('status-icon').style.color = '#ffb4ab'; // Error red
    document.getElementById('status').style.color = '#ffb4ab';
};

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.event === "GRAPH_DATA") {
        msg.data.junctions.forEach(j => {
            const marker = L.circleMarker([j.lat, j.lng], {
                color: '#adc6ff', // Primary blue
                radius: 8,
                weight: 2,
                fillOpacity: 0.8
            }).addTo(map);
            marker.bindPopup(`<b class="text-on-surface bg-surface p-1">${j.name}</b> (${j.id})`);
            markers[j.id] = marker;
        });
    }

    if (msg.event === "SIMULATED_TRAFFIC_STATE") {
        const list = document.getElementById('junctions-list');
        list.innerHTML = '';
        
        let globalAvgDelay = 0;
        let delayCount = 0;
        let globalMaxQueue = 0;
        let globalSpillbacks = 0;

        // Populate Green Wave Panel
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

        msg.data.junctions.forEach(j => {
            // Calc aggregate metrics for AURA
            let auraMaxQ = 0, auraDelay = 0, auraCount = 0;
            let auraApps = '';
            for (const [appr, state] of Object.entries(j.aura.approaches)) {
                auraMaxQ = Math.max(auraMaxQ, state.max_queue_pcu);
                if (state.avg_delay_seconds > 0) {
                    auraDelay += state.avg_delay_seconds;
                    auraCount++;
                }
                
                let sourceBadge = '';
                if (state.source_mode === 'LIVE') sourceBadge = `<span class="text-[10px] border border-secondary text-secondary rounded px-1 ml-2">LIVE</span>`;
                else if (state.source_mode === 'REPLAY') sourceBadge = `<span class="text-[10px] border border-tertiary text-tertiary rounded px-1 ml-2">REPLAY</span>`;
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
            if(auraCount > 0) delayCount++;
            globalMaxQueue = Math.max(globalMaxQueue, auraMaxQ);
            globalSpillbacks += j.aura.spillback_events;

            // Calc aggregate metrics for BASELINE
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

            // Junction Card HTML
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
            
            // Map Marker colors
            if (markers[j.junction_id]) {
                const activeColor = j.aura.approaches['NORTHBOUND'].signal_state === 'GREEN' ? '#4edea3' : '#ffb4ab';
                markers[j.junction_id].setStyle({ color: activeColor });
            }
        });

        // Update Top Metrics
        let finalAvgDelay = delayCount > 0 ? (globalAvgDelay / delayCount).toFixed(1) : 0;
        document.getElementById('metric-delay').innerText = `${finalAvgDelay}s`;
        document.getElementById('metric-demand').innerText = `${globalMaxQueue.toFixed(1)} PCU`;
        document.getElementById('metric-spillbacks').innerText = `${globalSpillbacks}`;
    }

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
                    <span>Congestion: ${Math.round(d.individual.congestionExposure*100)}%</span>
                </div>
                <p class="text-[10px] text-error opacity-80 italic">${d.individual.explanation}</p>
            </div>
            
            <div class="border border-secondary border-opacity-50 bg-secondary bg-opacity-10 rounded p-3">
                <h4 class="text-secondary font-bold text-body-md mb-1">AURA Cooperative Route</h4>
                <div class="text-on-surface text-body-sm mb-1">${d.aura.route.join(' &rarr; ')}</div>
                <div class="flex justify-between text-on-surface-variant text-[11px] mb-2">
                    <span>${d.aura.distance}m</span>
                    <span>${Math.round(d.aura.estimatedTime)}s</span>
                    <span>Congestion: ${Math.round(d.aura.congestionExposure*100)}%</span>
                </div>
                <p class="text-[11px] text-secondary font-bold mt-1">${d.aura.explanation}</p>
            </div>
        `;

        // Clear old lines
        if (window.routePolylines) {
            window.routePolylines.forEach(p => map.removeLayer(p));
        }
        window.routePolylines = [];

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
        
        // Offset individual route slightly
        drawPath(d.individual.route, '#ffb4ab', 4, '10, 10', 0.0005, 0); // Error color
        drawPath(d.aura.route, '#4edea3', 6, null, -0.0005, 0); // Secondary color
    }
};

function requestRoute() {
    const origin = document.getElementById('route-origin').value;
    const dest = document.getElementById('route-dest').value;
    ws.send(JSON.stringify({
        event: "ROUTE_REQUEST",
        data: { origin, destination: dest }
    }));
}
