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
        
        // Show Green Wave Info
        const gwContainer = document.createElement('div');
        gwContainer.style.background = '#222';
        gwContainer.style.padding = '10px';
        gwContainer.style.marginBottom = '15px';
        let gwHtml = `<h3>Green Wave Offsets (10 m/s)</h3><div style="display:flex; gap:10px;">`;
        if (msg.data.green_wave) {
            for (const [jid, data] of Object.entries(msg.data.green_wave)) {
                gwHtml += `<div style="background:#333; padding:5px; border-radius:4px; text-align:center;">
                    <b>${jid}</b><br>
                    <span style="color:#aaa">${data.offset}s</span><br>
                    <span style="color:${data.state === 'GREEN' ? '#4CAF50' : '#f44336'}">${data.state}</span>
                </div>`;
            }
        }
        gwHtml += `</div>`;
        gwContainer.innerHTML = gwHtml;
        list.appendChild(gwContainer);

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
                
                let sourceBadge = '';
                if (state.source_mode === 'LIVE') sourceBadge = `<span style="color: #4CAF50; font-size: 0.7rem; border: 1px solid #4CAF50; padding: 1px 3px; border-radius: 3px;">LIVE</span>`;
                else if (state.source_mode === 'REPLAY') sourceBadge = `<span style="color: #FFEB3B; font-size: 0.7rem; border: 1px solid #FFEB3B; padding: 1px 3px; border-radius: 3px;">REPLAY</span>`;
                else sourceBadge = `<span style="color: #9E9E9E; font-size: 0.7rem; border: 1px solid #9E9E9E; padding: 1px 3px; border-radius: 3px;">SIMULATED</span>`;

                auraApps += `<div class="approach-item">
                    <strong>${appr}</strong> ${sourceBadge}<br>
                    State: <span style="color:${state.signal_state === 'GREEN' ? '#4CAF50' : '#f44336'}">${state.signal_state}</span> | Q: ${state.queue_pcu} PCU
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
                    <strong>${appr}</strong><br>
                    State: <span style="color:${state.signal_state === 'GREEN' ? '#4CAF50' : '#f44336'}">${state.signal_state}</span> | Q: ${state.queue_pcu} PCU
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
