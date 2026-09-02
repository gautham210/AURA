const map = L.map('map').setView([9.98, 76.31], 12);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
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
        list.innerHTML = ''; // Clear

        msg.data.junctions.forEach(j => {
            const card = document.createElement('div');
            card.className = 'junction-card';
            let html = `<h3>${j.junction_id} (Phase ${j.current_phase})</h3><div class="approach-list">`;
            
            for (const [approach, state] of Object.entries(j.approaches)) {
                html += `<div class="approach-item">
                    <strong>${approach}</strong>: <span style="color:${state.signal_state === 'GREEN' ? '#4CAF50' : '#f44336'}">${state.signal_state}</span> | PCU: ${state.queue_pcu} | ${state.source_mode}
                </div>`;
            }
            html += `</div>`;
            card.innerHTML = html;
            list.appendChild(card);
            
            // Highlight active marker (mocking)
            if (markers[j.junction_id]) {
                const activeColor = j.approaches['NORTHBOUND'].signal_state === 'GREEN' ? '#4CAF50' : '#f44336';
                markers[j.junction_id].setStyle({ color: activeColor });
            }
        });
    }
};
