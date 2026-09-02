const map = L.map('map').setView([9.98, 76.31], 12);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abcd',
    maxZoom: 20
}).addTo(map);

let markers = {};

const ws = new WebSocket(`ws://${window.location.host}`);

ws.onopen = () => {
    document.getElementById('status').innerText = 'Connected';
    document.getElementById('status').style.color = '#4CAF50';
};

ws.onclose = () => {
    document.getElementById('status').innerText = 'Disconnected';
    document.getElementById('status').style.color = '#f44336';
};

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.event === "GRAPH_DATA") {
        msg.data.junctions.forEach(j => {
            const marker = L.circleMarker([j.lat, j.lng], {
                color: '#64B5F6',
                radius: 8,
                weight: 2
            }).addTo(map);
            marker.bindPopup(`<b>${j.name}</b> (${j.id})`);
            markers[j.id] = marker;
        });
    }

    if (msg.event === "SIMULATED_TRAFFIC_STATE") {
        const list = document.getElementById('junctions-list');
        list.innerHTML = '';

        msg.data.junctions.forEach(j => {
            const card = document.createElement('div');
            card.className = 'junction-card';
            
            // Calc aggregate metrics for AURA
            let auraMaxQ = 0, auraDelay = 0, auraCount = 0;
            let auraApps = '';
            for (const [appr, state] of Object.entries(j.aura.approaches)) {
                auraMaxQ = Math.max(auraMaxQ, state.max_queue_pcu);
                if (state.avg_delay_seconds > 0) {
                    auraDelay += state.avg_delay_seconds;
                    auraCount++;
                }
                auraApps += `<div class="approach-item">
                    <strong>${appr}</strong>: <span style="color:${state.signal_state === 'GREEN' ? '#4CAF50' : '#f44336'}">${state.signal_state}</span> | Q: ${state.queue_pcu} PCU
                </div>`;
            }
            auraDelay = auraCount > 0 ? (auraDelay / auraCount).toFixed(1) : 0;

            // Calc aggregate metrics for BASELINE
            let baseMaxQ = 0, baseDelay = 0, baseCount = 0;
            let baseApps = '';
            for (const [appr, state] of Object.entries(j.baseline.approaches)) {
                baseMaxQ = Math.max(baseMaxQ, state.max_queue_pcu);
                if (state.avg_delay_seconds > 0) {
                    baseDelay += state.avg_delay_seconds;
                    baseCount++;
                }
                baseApps += `<div class="approach-item">
                    <strong>${appr}</strong>: <span style="color:${state.signal_state === 'GREEN' ? '#4CAF50' : '#f44336'}">${state.signal_state}</span> | Q: ${state.queue_pcu} PCU
                </div>`;
            }
            baseDelay = baseCount > 0 ? (baseDelay / baseCount).toFixed(1) : 0;

            let html = `<h3>${j.junction_id} (Phase ${j.current_phase})</h3>
            <div style="font-size: 0.8rem; margin-bottom: 10px; color: #aaa;">Back-pressure: x${j.aura.back_pressure_multiplier.toFixed(2)}</div>
            <div class="comparison">
                <div class="aura-col">
                    <h4>AURA</h4>
                    ${auraApps}
                    <div class="metrics">
                        AVG DELAY: ${auraDelay}s<br>
                        MAX QUEUE: ${auraMaxQ.toFixed(1)} PCU<br>
                        SPILLBACKS: ${j.aura.spillback_events}
                    </div>
                </div>
                <div class="baseline-col">
                    <h4>BASELINE</h4>
                    ${baseApps}
                    <div class="metrics">
                        AVG DELAY: ${baseDelay}s<br>
                        MAX QUEUE: ${baseMaxQ.toFixed(1)} PCU<br>
                        SPILLBACKS: ${j.baseline.spillback_events}
                    </div>
                </div>
            </div>`;
            
            card.innerHTML = html;
            list.appendChild(card);
            
            if (markers[j.junction_id]) {
                const activeColor = j.aura.approaches['NORTHBOUND'].signal_state === 'GREEN' ? '#4CAF50' : '#f44336';
                markers[j.junction_id].setStyle({ color: activeColor });
            }
        });
    }
};
