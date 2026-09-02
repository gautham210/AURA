const ws = new WebSocket(`ws://${window.location.host}`);

class AuraStateStore {
    constructor() {
        this.graph = null;
        this.networkState = [];
        this.greenWave = {};
        this.selectedJunctionId = null;
        this.currentMode = 'CONTROL_ROOM'; // 'CONTROL_ROOM' or 'USER_VIEW'
        this.activePolylines = []; // For routing
        this.userOriginLat = null;
        this.userOriginLng = null;
    }

    updateGraph(graphData) {
        this.graph = graphData;
        initMap(this.graph);
        populateRoutingSelects(this.graph);
    }

    updateTrafficState(stateData) {
        this.networkState = stateData.junctions;
        this.greenWave = stateData.green_wave;
        
        updateTopMetrics(this.networkState);
        updateMapMarkers(this.networkState);
        updateGreenWavePanel(this.greenWave);
        updateDataSourceLabel(this.networkState);
        
        if (this.currentMode === 'CONTROL_ROOM' && this.selectedJunctionId) {
            renderJunctionDetail(this.selectedJunctionId);
        }
    }
}

const store = new AuraStateStore();
let map, edgeLayer, markerLayer, routingLayer;
const markers = {};

// DOM Elements
const tabControlRoom = document.getElementById('tab-control-room');
const tabUserView = document.getElementById('tab-user-view');
const drawerControl = document.getElementById('drawer-control');
const panelUserView = document.getElementById('panel-user-view');
const btnCloseDrawer = document.getElementById('btn-close-drawer');
const dataSourceLabel = document.getElementById('data-source');
const connectionStatus = document.getElementById('connection-status');
const crInsightsPanel = document.getElementById('cr-insights-panel');

// Initialization
function initMap(graphData) {
    if (map) return;
    map = L.map('map', { zoomControl: false }).setView([9.98, 76.31], 12);
    
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);

    edgeLayer = L.layerGroup().addTo(map);
    routingLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);

    map.on('click', (e) => {
        if (store.currentMode === 'USER_VIEW' && isMapSelectionMode) {
            setOriginLocation(e.latlng.lat, e.latlng.lng);
            isMapSelectionMode = false;
            document.getElementById('map').style.cursor = '';
            document.getElementById('origin-display').className = "text-xs font-mono text-[#10B981] px-3 py-2 bg-[#10B981]/10 rounded border border-[#10B981]/30";
        }
    });
    
    // Draw AURA Corridors
    graphData.edges.forEach(edge => {
        if (edge.is_aura_corridor) {
            L.polyline(edge.geometry, {
                color: '#424754',
                weight: 3,
                opacity: 0.6
            }).addTo(edgeLayer);
        }
    });

    // We don't draw raw OSM edges to avoid cluttering the UI. 
    // The base OSM map provides the visual roads.

    // Draw POIs
    graphData.pois.forEach(p => {
        let iconType = "POI";
        let bgColor = "bg-[#3B82F6]";
        let borderColor = "border-[#1E3A8A]";
        
        if (p.type === 'hospital' || p.type === 'clinic') {
            iconType = "🏥"; bgColor = "bg-[#EF4444]/20"; borderColor = "border-[#EF4444]";
        } else if (p.type === 'fire_station') {
            iconType = "🚒"; bgColor = "bg-[#F59E0B]/20"; borderColor = "border-[#F59E0B]";
        } else if (p.type === 'police') {
            iconType = "👮"; bgColor = "bg-[#3B82F6]/20"; borderColor = "border-[#3B82F6]";
        }
        
        const iconHtml = `
            <div class="relative flex items-center justify-center w-5 h-5 rounded-full ${bgColor} border ${borderColor} shadow-sm">
                <span class="text-[10px]">${iconType}</span>
            </div>
        `;
        const icon = L.divIcon({ className: 'custom-div-icon', html: iconHtml, iconSize: [20, 20], iconAnchor: [10, 10] });
        const marker = L.marker([p.lat, p.lng], { icon });
        marker.bindTooltip(`<b>${p.name}</b><br/>${p.type.replace('_', ' ')}`, { permanent: false, direction: 'top', className: 'junction-tooltip' });
        
        // Hide POIs on low zoom
        map.on('zoomend', function() {
            if (map.getZoom() < 14) {
                if (map.hasLayer(marker)) map.removeLayer(marker);
            } else {
                if (!map.hasLayer(marker)) marker.addTo(markerLayer);
            }
        });
    });

    // Draw Controlled Junctions
    const boundsArr = [];
    graphData.controlledJunctions.forEach(j => {
        boundsArr.push([j.lat, j.lng]);
        
        const iconHtml = `
            <div class="relative flex items-center justify-center w-6 h-6 rounded-full bg-[#161B22] border border-[#424754] shadow-md transition-colors cursor-pointer" id="marker-${j.id}">
                <span class="text-[9px] font-mono text-[#8c909f] font-bold" id="marker-text-${j.id}">${j.id}</span>
                <!-- Inner indicator -->
                <div class="absolute inset-[2px] rounded-full opacity-0 pointer-events-none border-2 border-transparent transition-all" id="marker-glow-${j.id}"></div>
            </div>
        `;
        
        const icon = L.divIcon({
            className: 'custom-div-icon',
            html: iconHtml,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        const marker = L.marker([j.lat, j.lng], { icon }).addTo(markerLayer);
        
        marker.bindTooltip(`<b>${j.id}</b> ${j.name}`, {
            permanent: true,
            direction: 'right',
            className: 'junction-tooltip',
            offset: [15, 0]
        });

        marker.on('click', () => {
            if (store.currentMode === 'CONTROL_ROOM') {
                selectJunction(j.id);
            }
        });

        markers[j.id] = { marker, elementId: `marker-${j.id}`, glowId: `marker-glow-${j.id}` };
    });

    if (boundsArr.length > 0) {
        map.fitBounds(boundsArr, { padding: [60, 60] });
    }
}

// UI Interactions
tabControlRoom.addEventListener('click', () => switchMode('CONTROL_ROOM'));
tabUserView.addEventListener('click', () => switchMode('USER_VIEW'));

btnCloseDrawer.addEventListener('click', () => {
    store.selectedJunctionId = null;
    drawerControl.classList.add('translate-x-full');
    highlightMarker(null);
});

function switchMode(mode) {
    store.currentMode = mode;
    
    if (mode === 'CONTROL_ROOM') {
        tabControlRoom.className = "text-sm font-semibold border-b-2 border-[#3B82F6] pb-1.5 text-[#3B82F6] transition-colors";
        tabUserView.className = "text-sm font-semibold border-b-2 border-transparent pb-1.5 text-[#8c909f] hover:text-[#e1e2ec] transition-colors";
        
        panelUserView.classList.add('hidden');
        crInsightsPanel.classList.remove('hidden');
        document.getElementById('top-metrics').classList.remove('hidden');
        
        if (store.selectedJunctionId) {
            drawerControl.classList.remove('translate-x-full');
        }
        
        routingLayer.clearLayers();
    } else {
        tabControlRoom.className = "text-sm font-semibold border-b-2 border-transparent pb-1.5 text-[#8c909f] hover:text-[#e1e2ec] transition-colors";
        tabUserView.className = "text-sm font-semibold border-b-2 border-[#3B82F6] pb-1.5 text-[#3B82F6] transition-colors";
        
        panelUserView.classList.remove('hidden');
        crInsightsPanel.classList.add('hidden');
        document.getElementById('top-metrics').classList.add('hidden');
        drawerControl.classList.add('translate-x-full');
        highlightMarker(null);
    }
    
    setTimeout(() => map.invalidateSize(), 100);
}

function selectJunction(id) {
    store.selectedJunctionId = id;
    highlightMarker(id);
    renderJunctionDetail(id);
    drawerControl.classList.remove('translate-x-full');
    
    const jData = store.graph.controlledJunctions.find(j => j.id === id);
    if (jData) {
        map.panTo([jData.lat, jData.lng]);
    }
}

function highlightMarker(selectedId) {
    Object.keys(markers).forEach(id => {
        const el = document.getElementById(markers[id].elementId);
        const textEl = document.getElementById(`marker-text-${id}`);
        if (el) {
            if (id === selectedId) {
                el.classList.add('border-[#3B82F6]', 'bg-[#1E3A8A]/50');
                el.classList.remove('border-[#424754]', 'bg-[#161B22]');
                el.style.boxShadow = '0 0 10px rgba(59, 130, 246, 0.4)';
                if(textEl) { textEl.classList.add('text-white'); textEl.classList.remove('text-[#8c909f]'); }
            } else {
                el.classList.remove('border-[#3B82F6]', 'bg-[#1E3A8A]/50');
                el.classList.add('border-[#424754]', 'bg-[#161B22]');
                el.style.boxShadow = 'none';
                if(textEl) { textEl.classList.remove('text-white'); textEl.classList.add('text-[#8c909f]'); }
            }
        }
    });
}

// Data Rendering
function updateTopMetrics(networkState) {
    if (networkState.length === 0) return;
    
    let totalDelay = 0;
    let delayCount = 0;
    let maxDemand = 0;
    let totalSpillbacks = 0;

    networkState.forEach(j => {
        totalSpillbacks += j.aura.spillback_events || 0;
        
        Object.values(j.aura.approaches).forEach(app => {
            if (app.avg_delay_seconds > 0) {
                totalDelay += app.avg_delay_seconds;
                delayCount++;
            }
            if (app.queue_pcu > maxDemand) {
                maxDemand = app.queue_pcu;
            }
        });
    });

    const avgDelay = delayCount > 0 ? (totalDelay / delayCount).toFixed(1) : "0.0";
    
    document.getElementById('metric-delay').textContent = `${avgDelay}s`;
    document.getElementById('metric-demand').textContent = maxDemand.toFixed(1);
    document.getElementById('metric-spillbacks').textContent = totalSpillbacks;
}

function updateMapMarkers(networkState) {
    networkState.forEach(j => {
        const m = markers[j.junction_id];
        if (!m) return;
        
        const glowEl = document.getElementById(m.glowId);
        if (glowEl) {
            // Find max queue to set congestion color
            let maxQ = 0;
            Object.values(j.aura.approaches).forEach(app => {
                if (app.queue_pcu > maxQ) maxQ = app.queue_pcu;
            });
            
            if (maxQ > 30) {
                glowEl.className = 'absolute inset-[2px] rounded-full pointer-events-none border-2 border-[#EF4444] shadow-[inset_0_0_8px_rgba(239,68,68,0.5)] opacity-100 animate-pulse';
            } else if (maxQ > 15) {
                glowEl.className = 'absolute inset-[2px] rounded-full pointer-events-none border-2 border-[#F59E0B] shadow-[inset_0_0_8px_rgba(245,158,11,0.3)] opacity-100';
            } else {
                glowEl.className = 'absolute inset-[2px] rounded-full opacity-0 pointer-events-none border-2 border-transparent';
            }
        }
    });
}

function renderJunctionDetail(id) {
    const jNode = store.graph.controlledJunctions.find(j => j.id === id);
    const jState = store.networkState.find(s => s.junction_id === id);
    if (!jNode || !jState) return;

    // Header
    document.getElementById('drawer-jid').textContent = id;
    document.getElementById('drawer-title').textContent = jNode.name;
    document.getElementById('drawer-phase').textContent = jState.current_phase || jState.aura.current_phase;
    
    // Semantics from Backend
    const activeMovements = jState.aura.current_phase_description || "--";
    document.getElementById('drawer-phase-desc').textContent = `ACTIVE MOVEMENTS: ${activeMovements}`;

    // 4-Way Visual
    document.getElementById('center-sig-id').textContent = id;
    const dirs = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];
    dirs.forEach(dir => {
        const el = document.getElementById(`sig-${dir}`);
        if (el) {
            const appState = jState.aura.approaches[dir];
            if (appState) {
                if (appState.signal_state === "GREEN") {
                    el.className = "w-5 h-5 rounded-full border border-[#424754] signal-green";
                } else {
                    el.className = "w-5 h-5 rounded-full border border-[#424754] signal-red";
                }
            } else {
                // Direction doesn't exist at this junction
                el.className = "w-5 h-5 rounded-full bg-[#161B22] border border-[#30363D]";
            }
        }
    });

    // Approaches Data
    const approachesContainer = document.getElementById('drawer-approaches');
    approachesContainer.innerHTML = '';
    
    dirs.forEach(dir => {
        const appState = jState.aura.approaches[dir];
        if (appState) {
            const color = appState.signal_state === "GREEN" ? "text-[#10B981]" : "text-[#EF4444]";
            const html = `
                <div class="bg-[#10131a] border border-[#30363D] rounded p-2 flex justify-between items-center">
                    <div class="flex items-center gap-2">
                        <span class="text-[10px] font-bold text-[#8c909f] w-14">${dir.substring(0,5)}</span>
                        <span class="text-[10px] font-bold ${color}">${appState.signal_state}</span>
                        <span class="text-[8px] font-mono px-1 rounded bg-[#30363D] text-[#e1e2ec]">${appState.source_mode || 'SIM'}</span>
                    </div>
                    <div class="flex items-center gap-3 font-mono text-[11px]">
                        <div class="flex flex-col items-end"><span class="text-[#8c909f] text-[8px]">PCU</span><span class="text-white">${appState.queue_pcu.toFixed(1)}</span></div>
                        <div class="flex flex-col items-end"><span class="text-[#8c909f] text-[8px]">DLY</span><span class="text-white">${appState.avg_delay_seconds.toFixed(1)}s</span></div>
                    </div>
                </div>
            `;
            approachesContainer.insertAdjacentHTML('beforeend', html);
        }
    });

    // Network Effect & AURA Decision
    const bp = jState.aura.back_pressure_multiplier;
    const util = Math.round((1.0 - bp) * 100); // Rough approximation for display if util isn't directly exposed
    
    document.getElementById('drawer-backpressure').textContent = bp < 1.0 ? `HIGH (BP: ${bp.toFixed(2)})` : "NOMINAL";
    if (bp < 1.0) {
        document.getElementById('drawer-backpressure').className = "font-mono text-[#EF4444] font-bold bg-[#EF4444]/10 px-2 py-0.5 rounded";
    } else {
        document.getElementById('drawer-backpressure').className = "font-mono text-[#10B981] font-bold bg-[#10B981]/10 px-2 py-0.5 rounded";
    }

    document.getElementById('drawer-explanation').textContent = generateAuraExplanation(jState);

    // Evidence
    // Find the primary source across approaches
    let source = "SIMULATED";
    let totalPcu = 0;
    dirs.forEach(dir => {
        if (jState.aura.approaches[dir]) {
            if (jState.aura.approaches[dir].source_mode === "LIVE") source = "LIVE";
            else if (jState.aura.approaches[dir].source_mode === "REPLAY" && source !== "LIVE") source = "REPLAY";
            totalPcu += jState.aura.approaches[dir].queue_pcu;
        }
    });

    document.getElementById('ev-source').textContent = source;
    document.getElementById('ev-pcu').textContent = `${totalPcu.toFixed(1)} PCU`;
    document.getElementById('ev-timestamp').textContent = new Date().toLocaleTimeString();
}

function generateAuraExplanation(jState) {
    const bp = jState.aura.back_pressure_multiplier;
    let maxQ = 0;
    let bottleneckDir = "";
    
    Object.keys(jState.aura.approaches).forEach(dir => {
        if (jState.aura.approaches[dir].queue_pcu > maxQ) {
            maxQ = jState.aura.approaches[dir].queue_pcu;
            bottleneckDir = dir;
        }
    });

    if (bp < 0.8) {
        return `Downstream congestion detected. Applied back-pressure penalty (x${bp}) to restrict incoming volume and prevent spillback.`;
    } else if (maxQ > 30) {
        return `High localized demand on ${bottleneckDir} approach (${maxQ.toFixed(1)} PCU). AURA dynamically prioritizing phase allocation.`;
    } else {
        return `Network capacity nominal. AURA allocating standard proportional green times to balance flows.`;
    }
}

function updateGreenWavePanel(gwData) {
    const grid = document.getElementById('green-wave-grid');
    grid.innerHTML = '';
    
    Object.keys(gwData).forEach(jid => {
        const data = gwData[jid];
        const color = data.state === "GREEN" ? "text-[#10B981]" : "text-[#EF4444]";
        const html = `
            <div class="bg-[#0B0E14] border border-[#30363D] rounded p-2 flex justify-between items-center">
                <span class="text-[10px] font-bold text-[#8c909f]">${jid}</span>
                <span class="text-[10px] font-mono font-bold ${color}">${data.offset}s ${data.state}</span>
            </div>
        `;
        grid.insertAdjacentHTML('beforeend', html);
    });
}

function updateDataSourceLabel(networkState) {
    let hasLive = false;
    let hasReplay = false;

    networkState.forEach(j => {
        Object.values(j.aura.approaches).forEach(app => {
            if (app.source_mode === "LIVE") hasLive = true;
            if (app.source_mode === "REPLAY") hasReplay = true;
        });
    });

    if (hasLive) {
        dataSourceLabel.textContent = "DATA: LIVE";
        dataSourceLabel.className = "text-[10px] font-mono font-bold px-2 py-0.5 rounded border border-[#10B981]/50 bg-[#10B981]/10 text-[#10B981]";
    } else if (hasReplay) {
        dataSourceLabel.textContent = "DATA: REPLAY";
        dataSourceLabel.className = "text-[10px] font-mono font-bold px-2 py-0.5 rounded border border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B]";
    } else {
        dataSourceLabel.textContent = "DATA: SIMULATED";
        dataSourceLabel.className = "text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-[#32353c] text-[#8c909f] border border-[#424754]";
    }
}

// User View Routing
function populateRoutingSelects(graphData) {
    const dest = document.getElementById('user-destination');
    dest.innerHTML = '';
    
    // Add default prompt option
    const defaultOpt = new Option('Select a destination...', '');
    defaultOpt.disabled = true;
    defaultOpt.selected = true;
    dest.add(defaultOpt);
    
    const groups = {
        'Hospitals': { types: ['hospital', 'clinic'], prefix: '🏥' },
        'Fire & Rescue': { types: ['fire_station'], prefix: '🚒' },
        'Police': { types: ['police'], prefix: '👮' }
    };
    
    Object.keys(groups).forEach(groupName => {
        const groupInfo = groups[groupName];
        const poisInGroup = graphData.pois.filter(p => groupInfo.types.includes(p.type));
        
        if (poisInGroup.length > 0) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = groupName;
            
            // Sort alphabetically within the group
            poisInGroup.sort((a, b) => a.name.localeCompare(b.name));
            
            poisInGroup.forEach(p => {
                const opt = new Option(`${groupInfo.prefix} ${p.name}`, p.nearestNode);
                optgroup.appendChild(opt);
            });
            
            dest.appendChild(optgroup);
        }
    });
}

let userOriginMarker = null;

function setOriginLocation(lat, lng) {
    store.userOriginLat = lat;
    store.userOriginLng = lng;
    
    if (userOriginMarker) {
        map.removeLayer(userOriginMarker);
    }
    
    userOriginMarker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: 'custom-div-icon',
            html: '<div class="flex items-center justify-center w-4 h-4 rounded-full bg-[#10B981] border-2 border-white shadow-lg z-50"></div>',
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        })
    }).addTo(map);
    userOriginMarker.bindTooltip("📍 START", { permanent: true, direction: "top", className: "junction-tooltip" }).openTooltip();
    
    document.getElementById('origin-display').classList.remove('hidden');
    document.getElementById('origin-display').textContent = `Origin set at ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

document.getElementById('btn-use-location').addEventListener('click', () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(position => {
            setOriginLocation(position.coords.latitude, position.coords.longitude);
            map.flyTo([position.coords.latitude, position.coords.longitude], 15);
        }, err => {
            alert("Geolocation failed or denied. Defaulting to Edappally.");
            // Default to near Edappally
            setOriginLocation(10.0261, 76.3084);
            map.flyTo([10.0261, 76.3084], 15);
        });
    }
});

let isMapSelectionMode = false;
document.getElementById('btn-map-origin').addEventListener('click', () => {
    isMapSelectionMode = true;
    document.getElementById('map').style.cursor = 'crosshair';
    document.getElementById('origin-display').classList.remove('hidden');
    document.getElementById('origin-display').className = "text-xs font-mono text-[#F59E0B] px-3 py-2 bg-[#F59E0B]/10 rounded border border-[#F59E0B]/30";
    document.getElementById('origin-display').textContent = "Click anywhere on a drivable Kochi road.";
});


document.getElementById('btn-user-route').addEventListener('click', () => {
    if (!store.userOriginLat || !store.userOriginLng) {
        alert("Please select a starting location first.");
        return;
    }
    const dest = document.getElementById('user-destination').value;
    if (!dest) {
        alert("Please select a destination first.");
        return;
    }
    
    ws.send(JSON.stringify({
        event: "ROUTE_REQUEST",
        data: { 
            origin: { lat: store.userOriginLat, lng: store.userOriginLng }, 
            destination: dest 
        }
    }));
});

function drawRoutePolylines(auraData, fastData) {
    routingLayer.clearLayers();
    if (!store.graph) return;

    // Draw Fast path
    if (fastData && fastData.geometry && fastData.geometry.length > 0) {
        L.polyline(fastData.geometry, {
            color: '#F59E0B',
            weight: 4,
            opacity: 0.6,
            dashArray: '8, 8'
        }).addTo(routingLayer);
    }

    // Draw AURA path
    if (auraData && auraData.geometry && auraData.geometry.length > 0) {
        L.polyline(auraData.geometry, {
            color: '#10B981',
            weight: 6,
            opacity: 0.9
        }).addTo(routingLayer);
    }
}

// WebSocket Handling
ws.onopen = () => {
    connectionStatus.textContent = "● CONNECTED";
    connectionStatus.className = "text-[9px] font-mono font-bold text-[#10B981] px-1";
};

ws.onclose = () => {
    connectionStatus.textContent = "● DISCONNECTED";
    connectionStatus.className = "text-[9px] font-mono font-bold text-[#EF4444] px-1";
};

ws.onmessage = (evt) => {
    try {
        const payload = JSON.parse(evt.data);
        if (payload.event === "GRAPH_DATA") {
            store.updateGraph(payload.data);
        } else if (payload.event === "SIMULATED_TRAFFIC_STATE") {
            store.updateTrafficState(payload.data);
        } else if (payload.event === "ROUTE_RESULT") {
            handleRouteResult(payload.data);
        }
    } catch (e) {
        console.error("WS parse error", e);
    }
};

function handleRouteResult(data) {
    if (data.error) {
        alert(data.error);
        return;
    }
    const resultsContainer = document.getElementById('user-route-results');
    resultsContainer.classList.remove('hidden');

    const aura = data.aura;
    const fast = data.individual;

    const auraJuncs = aura.controlledJunctionsPassed.map(j => `<span class="px-2 py-0.5 bg-[#161B22] border border-[#30363D] rounded text-white text-[10px]">${j.id} ${j.name}</span>`).join(' ➔ ');
    const fastJuncs = fast.controlledJunctionsPassed.map(j => j.id).join(' → ');

    document.getElementById('aura-time').textContent = `${Math.ceil(aura.estimatedTime / 60)} min`;
    document.getElementById('aura-path').innerHTML = auraJuncs || "No controlled junctions on route";
    document.getElementById('aura-explanation').textContent = aura.explanation || "AURA cooperative routing applied.";
    
    document.getElementById('fast-time').textContent = `${Math.ceil(fast.estimatedTime / 60)} min`;
    document.getElementById('fast-path').textContent = fastJuncs || "Direct Route";
    document.getElementById('fast-explanation').textContent = fast.explanation || "Shortest path without cooperative penalties.";
    
    if (Math.ceil(aura.estimatedTime / 60) > Math.ceil(fast.estimatedTime / 60)) {
        document.getElementById('aura-diff').textContent = `+${Math.round((aura.estimatedTime - fast.estimatedTime))}s DELAY`;
        document.getElementById('fast-diff').textContent = "FASTEST";
    } else {
        document.getElementById('aura-diff').textContent = "OPTIMAL";
        document.getElementById('fast-diff').textContent = "SUB-OPTIMAL";
    }

    drawRoutePolylines(aura, fast);
}

// Insights Panel Toggle
document.getElementById('btn-toggle-insights').addEventListener('click', () => {
    const content = document.getElementById('insights-content');
    const icon = document.getElementById('cr-insights-icon');
    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        icon.textContent = '▼';
    } else {
        content.classList.add('hidden');
        icon.textContent = '▲';
    }
});
