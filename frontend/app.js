const ws = new WebSocket(`ws://${window.location.host}`);

class AuraStateStore {
    constructor() {
        this.graph = null;
        this.networkState = [];
        this.greenWave = {};
        this.selectedJunctionId = null;
        this.currentMode = 'CONTROL_ROOM'; // 'CONTROL_ROOM' or 'USER_VIEW'
        this.userOriginLat = null;
        this.userOriginLng = null;
        this.userDest = null; // Can be nodeId string or {lat, lng}
    }

    updateGraph(graphData) {
        this.graph = graphData;
        initMap(this.graph);
        populateRoutingSelects(this.graph);
    }

    updateTrafficState(stateData) {
        this.networkState = stateData.junctions;
        this.greenWave = stateData.green_wave || {};
        
        updateTopMetrics(this.networkState);
        updateMapMarkers(this.networkState);
        updateTrafficBlips(this.networkState);
        updateGreenWavePanel(this.greenWave);
        updateDataSourceLabel(this.networkState);
        
        if (this.currentMode === 'CONTROL_ROOM' && this.selectedJunctionId) {
            renderJunctionDetail(this.selectedJunctionId);
        }
    }
}

const store = new AuraStateStore();
let map, corridorLayer, poiLayer, markerLayer, trafficBlipLayer, routingLayer;
const junctionMarkers = {};
const trafficBlips = {};
let isMapOriginSelectionMode = false;
let isMapDestSelectionMode = false;
let userOriginMarker = null;
let userDestMarker = null;

// DOM Elements
const tabControlRoom = document.getElementById('tab-control-room');
const tabUserView = document.getElementById('tab-user-view');
const drawerControl = document.getElementById('drawer-control');
const panelUserView = document.getElementById('panel-user-view');
const btnCloseDrawer = document.getElementById('btn-close-drawer');
const dataSourceLabel = document.getElementById('data-source');
const connectionStatus = document.getElementById('connection-status');
const crInsightsPanel = document.getElementById('cr-insights-panel');

// Setup Tabs
tabControlRoom.addEventListener('click', () => switchMode('CONTROL_ROOM'));
tabUserView.addEventListener('click', () => switchMode('USER_VIEW'));
btnCloseDrawer.addEventListener('click', () => {
    drawerControl.classList.add('translate-x-full');
    store.selectedJunctionId = null;
    highlightMarker(null);
});

function switchMode(mode) {
    store.currentMode = mode;
    
    if (mode === 'CONTROL_ROOM') {
        tabControlRoom.className = "text-xs font-bold px-3 py-1.5 rounded-md border border-[#3B82F6] bg-[#1E3A8A]/30 text-[#60A5FA] transition-all flex items-center gap-1.5 shadow-sm";
        tabUserView.className = "text-xs font-semibold px-3 py-1.5 rounded-md border border-transparent text-[#8b949e] hover:text-[#f0f6fc] hover:bg-[#21262d] transition-all flex items-center gap-1.5";
        
        panelUserView.classList.add('hidden');
        crInsightsPanel.classList.remove('hidden');
        document.getElementById('top-metrics').classList.remove('hidden');
        
        // Show Control Room Layers
        if (corridorLayer && !map.hasLayer(corridorLayer)) map.addLayer(corridorLayer);
        if (poiLayer && !map.hasLayer(poiLayer)) map.addLayer(poiLayer);
        if (markerLayer && !map.hasLayer(markerLayer)) map.addLayer(markerLayer);
        if (trafficBlipLayer && !map.hasLayer(trafficBlipLayer)) map.addLayer(trafficBlipLayer);
        
        // Clean User View Markers
        if (userOriginMarker && map.hasLayer(userOriginMarker)) map.removeLayer(userOriginMarker);
        if (userDestMarker && map.hasLayer(userDestMarker)) map.removeLayer(userDestMarker);
        if (routingLayer) routingLayer.clearLayers();
        
        if (store.selectedJunctionId) {
            drawerControl.classList.remove('translate-x-full');
        }
    } else {
        tabControlRoom.className = "text-xs font-semibold px-3 py-1.5 rounded-md border border-transparent text-[#8b949e] hover:text-[#f0f6fc] hover:bg-[#21262d] transition-all flex items-center gap-1.5";
        tabUserView.className = "text-xs font-bold px-3 py-1.5 rounded-md border border-[#3B82F6] bg-[#1E3A8A]/30 text-[#60A5FA] transition-all flex items-center gap-1.5 shadow-sm";
        
        panelUserView.classList.remove('hidden');
        crInsightsPanel.classList.add('hidden');
        document.getElementById('top-metrics').classList.add('hidden');
        drawerControl.classList.add('translate-x-full');
        highlightMarker(null);
        
        // Hide technical Control Room layers for clean driver UX
        if (corridorLayer && map.hasLayer(corridorLayer)) map.removeLayer(corridorLayer);
        if (poiLayer && map.hasLayer(poiLayer)) map.removeLayer(poiLayer);
        if (markerLayer && map.hasLayer(markerLayer)) map.removeLayer(markerLayer);
        if (trafficBlipLayer && map.hasLayer(trafficBlipLayer)) map.removeLayer(trafficBlipLayer);
    }
    
    setTimeout(() => map && map.invalidateSize(), 100);
}

// -------------------------------------------------------------
// Map Initialization (OpenStreetMap Standard Keyless Layer)
// -------------------------------------------------------------
function initMap(graphData) {
    if (map) return;
    
    map = L.map('map', { zoomControl: false }).setView([9.995, 76.305], 12);
    
    // Zoom control in top-right
    L.control.zoom({ position: 'topright' }).addTo(map);
    
    // 100% Keyless OpenStreetMap Standard Tiles with dark cybernetic filter
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        className: 'osm-dark-tiles',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    corridorLayer = L.layerGroup().addTo(map);
    poiLayer = L.layerGroup().addTo(map);
    trafficBlipLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    routingLayer = L.layerGroup().addTo(map);

    // Map Click Handler for User View
    map.on('click', (e) => {
        if (store.currentMode === 'USER_VIEW') {
            if (isMapOriginSelectionMode) {
                setOriginLocation(e.latlng.lat, e.latlng.lng);
                isMapOriginSelectionMode = false;
                document.getElementById('map').style.cursor = '';
            } else if (isMapDestSelectionMode) {
                setDestinationLocation(e.latlng.lat, e.latlng.lng);
                isMapDestSelectionMode = false;
                document.getElementById('map').style.cursor = '';
            }
        }
    });

    // 1. Draw AURA Corridors (Real OSM Geometry)
    graphData.edges.forEach(edge => {
        if (edge.is_aura_corridor && edge.geometry && edge.geometry.length > 0) {
            L.polyline(edge.geometry, {
                color: '#3B82F6',
                weight: 3.5,
                opacity: 0.75,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(corridorLayer);
        }
    });

    // 2. Draw Hospital POIs (Control Room Only)
    drawHospitalPOIs(graphData.pois);

    // 3. Draw Six Controlled Junctions (J1 to J6)
    drawControlledJunctions(graphData.controlledJunctions);
}

// -------------------------------------------------------------
// Draw Hospital POIs (Filtered strictly to genuine Hospitals)
// -------------------------------------------------------------
function drawHospitalPOIs(pois) {
    if (!pois) return;
    
    // Strict filter: only items whose name contains "Hospital"
    const hospitals = pois.filter(p => (p.type === 'hospital' || p.type === 'clinic') && /hospital/i.test(p.name));
    
    // Update badge in top bar
    const badge = document.getElementById('poi-summary-badge');
    if (badge) badge.textContent = `🏥 ${hospitals.length} Hospitals`;

    hospitals.forEach(p => {
        const iconHtml = `
            <div class="relative flex items-center justify-center w-5 h-5 rounded-full bg-[#EF4444]/20 border border-[#EF4444] shadow-md transition-transform hover:scale-125">
                <span class="text-[10px] leading-none">🏥</span>
            </div>
        `;
        
        const icon = L.divIcon({
            className: 'poi-custom-icon',
            html: iconHtml,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });

        const marker = L.marker([p.lat, p.lng], { icon });
        marker.bindTooltip(`<b>${p.name}</b><br/><span class="text-[#F87171] font-mono text-[9px] uppercase">HOSPITAL</span>`, {
            permanent: false,
            direction: 'top',
            className: 'aura-tooltip'
        });

        marker.addTo(poiLayer);
    });
}

// -------------------------------------------------------------
// Draw Controlled Junctions (J1 to J6)
// -------------------------------------------------------------
function drawControlledJunctions(junctions) {
    const bounds = [];

    junctions.forEach(j => {
        bounds.push([j.lat, j.lng]);

        const iconHtml = `
            <div class="relative flex items-center justify-center cursor-pointer group" id="marker-${j.id}">
                <!-- Outer status halo -->
                <div id="marker-halo-${j.id}" class="absolute -inset-1.5 rounded-full border-2 border-[#10B981] opacity-70 transition-all duration-300"></div>
                
                <!-- Main Badge Core -->
                <div class="relative w-8 h-8 rounded-full bg-[#0d1117] border border-[#30363d] flex items-center justify-center shadow-2xl z-10">
                    <span class="text-[11px] font-mono font-bold text-white tracking-tight" id="marker-text-${j.id}">${j.id}</span>
                    <!-- Signal Pip Indicator -->
                    <span id="marker-pip-${j.id}" class="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#10B981] border-2 border-[#0d1117]"></span>
                </div>
            </div>
        `;

        const icon = L.divIcon({
            className: 'junction-custom-icon',
            html: iconHtml,
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        });

        const marker = L.marker([j.lat, j.lng], { icon }).addTo(markerLayer);

        marker.bindTooltip(`<b>${j.id}</b> ${j.name}`, {
            permanent: true,
            direction: 'right',
            className: 'aura-tooltip',
            offset: [16, 0]
        });

        marker.on('click', () => {
            if (store.currentMode === 'CONTROL_ROOM') {
                selectJunction(j.id);
            }
        });

        junctionMarkers[j.id] = {
            marker,
            haloId: `marker-halo-${j.id}`,
            pipId: `marker-pip-${j.id}`,
            lat: j.lat,
            lng: j.lng,
            osmNodeId: j.osmNodeId
        };
    });

    if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [60, 60] });
    }
}

// -------------------------------------------------------------
// Real Traffic Blip Visualization (Aligned to Real Road Geometry)
// -------------------------------------------------------------
function updateTrafficBlips(networkState) {
    if (!networkState || !trafficBlipLayer || !store.graph) return;

    // Compass fallback offsets in case an approach has no direct edge
    const fallbackOffsets = {
        "NORTHBOUND": [ 0.0018, 0.0000 ],
        "SOUTHBOUND": [ -0.0018, 0.0000 ],
        "EASTBOUND":  [ 0.0000, 0.0022 ],
        "WESTBOUND":  [ 0.0000, -0.0022 ]
    };

    networkState.forEach(j => {
        const jm = junctionMarkers[j.junction_id];
        if (!jm) return;

        Object.entries(j.aura.approaches).forEach(([dir, appState]) => {
            const blipKey = `${j.junction_id}_${dir}`;
            
            // Look for the actual incoming road edge in the graph
            let blipLat = jm.lat + fallbackOffsets[dir][0];
            let blipLng = jm.lng + fallbackOffsets[dir][1];

            const incomingEdge = store.graph.edges.find(e => 
                (e.to === jm.osmNodeId || e.to === j.junction_id) && 
                e.approachAtTarget === dir && 
                e.geometry && e.geometry.length >= 2
            );

            if (incomingEdge) {
                // Use the upstream point along the road geometry
                const upstreamPoint = incomingEdge.geometry[incomingEdge.geometry.length - 2];
                blipLat = upstreamPoint[0];
                blipLng = upstreamPoint[1];
            }

            const q = appState.queue_pcu || 0;
            const mode = appState.source_mode || "SIMULATED";

            if (q > 0.5) {
                let colorClass = "bg-[#10B981]";
                let borderColor = "border-[#10B981]";
                let sizePx = 11;

                if (q > 25) {
                    colorClass = "bg-[#EF4444]";
                    borderColor = "border-[#EF4444]";
                    sizePx = 17;
                } else if (q > 10) {
                    colorClass = "bg-[#F59E0B]";
                    borderColor = "border-[#F59E0B]";
                    sizePx = 14;
                }

                const blipHtml = `
                    <div class="relative flex items-center justify-center queue-blip" style="width:${sizePx}px; height:${sizePx}px">
                        <div class="absolute inset-0 rounded-full ${colorClass} opacity-40 animate-ping"></div>
                        <div class="w-full h-full rounded-full ${colorClass} border ${borderColor} shadow-lg flex items-center justify-center">
                            <span class="text-[7px] font-mono text-white font-bold">${Math.round(q)}</span>
                        </div>
                    </div>
                `;

                if (!trafficBlips[blipKey]) {
                    const blipIcon = L.divIcon({
                        className: 'blip-custom-icon',
                        html: blipHtml,
                        iconSize: [sizePx, sizePx],
                        iconAnchor: [sizePx/2, sizePx/2]
                    });
                    const marker = L.marker([blipLat, blipLng], { icon: blipIcon }).addTo(trafficBlipLayer);
                    marker.bindTooltip(`<b>${j.junction_id} ${dir}</b><br/>Queue: ${q.toFixed(1)} PCU (${mode})`, {
                        direction: 'top',
                        className: 'aura-tooltip'
                    });
                    trafficBlips[blipKey] = marker;
                } else {
                    const blipIcon = L.divIcon({
                        className: 'blip-custom-icon',
                        html: blipHtml,
                        iconSize: [sizePx, sizePx],
                        iconAnchor: [sizePx/2, sizePx/2]
                    });
                    trafficBlips[blipKey].setIcon(blipIcon);
                    trafficBlips[blipKey].setLatLng([blipLat, blipLng]);
                    trafficBlips[blipKey].setTooltipContent(`<b>${j.junction_id} ${dir}</b><br/>Queue: ${q.toFixed(1)} PCU (${mode})`);
                }
            } else {
                if (trafficBlips[blipKey]) {
                    trafficBlipLayer.removeLayer(trafficBlips[blipKey]);
                    delete trafficBlips[blipKey];
                }
            }
        });
    });
}

// -------------------------------------------------------------
// Real-time Marker & Signal Updates
// -------------------------------------------------------------
function updateMapMarkers(networkState) {
    networkState.forEach(j => {
        const jm = junctionMarkers[j.junction_id];
        if (!jm) return;

        const haloEl = document.getElementById(jm.haloId);
        const pipEl = document.getElementById(jm.pipId);

        let maxQ = 0;
        let isGreen = false;

        Object.values(j.aura.approaches).forEach(app => {
            if (app.queue_pcu > maxQ) maxQ = app.queue_pcu;
            if (app.signal_state === "GREEN") isGreen = true;
        });

        // Update Halo (Congestion state)
        if (haloEl) {
            if (maxQ > 25) {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#EF4444] shadow-[0_0_12px_rgba(239,68,68,0.8)] opacity-90 animate-pulse";
            } else if (maxQ > 10) {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#F59E0B] shadow-[0_0_8px_rgba(245,158,11,0.5)] opacity-80";
            } else {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#10B981] opacity-70";
            }
        }

        // Update Pip (Signal state)
        if (pipEl) {
            if (isGreen) {
                pipEl.className = "absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#10B981] border-2 border-[#0d1117] shadow-[0_0_6px_#10B981]";
            } else {
                pipEl.className = "absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#EF4444] border-2 border-[#0d1117]";
            }
        }
    });
}

// -------------------------------------------------------------
// Top Metrics Strip Updates
// -------------------------------------------------------------
function updateTopMetrics(networkState) {
    if (!networkState || networkState.length === 0) return;
    
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
    document.getElementById('metric-demand').textContent = `${maxDemand.toFixed(1)} PCU`;
    document.getElementById('metric-spillbacks').textContent = totalSpillbacks;
}

// -------------------------------------------------------------
// Junction Selection & Detail Drawer
// -------------------------------------------------------------
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
    Object.keys(junctionMarkers).forEach(id => {
        const markerObj = junctionMarkers[id];
        const haloEl = document.getElementById(markerObj.haloId);
        if (haloEl) {
            if (id === selectedId) {
                haloEl.classList.add('border-[#3B82F6]', 'scale-125');
                haloEl.style.boxShadow = '0 0 16px rgba(59, 130, 246, 0.9)';
            } else {
                haloEl.classList.remove('border-[#3B82F6]', 'scale-125');
                haloEl.style.boxShadow = '';
            }
        }
    });
}

function renderJunctionDetail(id) {
    const jNode = store.graph.controlledJunctions.find(j => j.id === id);
    const jState = store.networkState.find(s => s.junction_id === id);
    if (!jNode || !jState) return;

    // Header Info
    document.getElementById('drawer-jid').textContent = id;
    document.getElementById('drawer-title').textContent = jNode.name;
    document.getElementById('drawer-phase').textContent = `PHASE ${jState.current_phase || jState.aura.current_phase}`;
    
    // Authoritative Phase Description from Backend
    const activeMovements = jState.aura.current_phase_description || "--";
    document.getElementById('drawer-phase-desc').textContent = `ACTIVE MOVEMENTS: ${activeMovements}`;

    // 4-Way Signal Light Visuals
    document.getElementById('center-sig-id').textContent = id;
    const dirs = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];
    
    dirs.forEach(dir => {
        const el = document.getElementById(`sig-${dir}`);
        if (el) {
            const appState = jState.aura.approaches[dir];
            if (appState) {
                if (appState.signal_state === "GREEN") {
                    el.className = "w-5 h-5 rounded-full border border-[#30363d] signal-green";
                } else {
                    el.className = "w-5 h-5 rounded-full border border-[#30363d] signal-red";
                }
            } else {
                el.className = "w-5 h-5 rounded-full bg-[#21262d] border border-[#30363d]";
            }
        }
    });

    // Approach Telemetry Table
    const approachesContainer = document.getElementById('drawer-approaches');
    approachesContainer.innerHTML = '';
    
    dirs.forEach(dir => {
        const appState = jState.aura.approaches[dir];
        if (appState) {
            const isGreen = appState.signal_state === "GREEN";
            const sigBadge = isGreen ? "bg-[#10B981]/20 text-[#10B981] border-[#10B981]/40" : "bg-[#EF4444]/20 text-[#EF4444] border-[#EF4444]/40";
            const modeBadge = appState.source_mode === "LIVE" ? "text-[#10B981]" : (appState.source_mode === "REPLAY" ? "text-[#F59E0B]" : "text-[#8b949e]");

            const html = `
                <div class="bg-[#0d1117] border border-[#30363d] rounded-md p-2.5 flex justify-between items-center shadow-sm">
                    <div class="flex items-center gap-2.5">
                        <span class="text-[10px] font-mono font-bold text-[#8b949e] w-14">${dir.substring(0,5)}</span>
                        <span class="text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${sigBadge}">${appState.signal_state}</span>
                        <span class="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#161b22] border border-[#30363d] ${modeBadge}">${appState.source_mode || 'SIM'}</span>
                    </div>
                    <div class="flex items-center gap-4 font-mono text-xs">
                        <div class="flex flex-col items-end">
                            <span class="text-[#8b949e] text-[8px] uppercase">Queue</span>
                            <span class="text-white font-semibold">${appState.queue_pcu.toFixed(1)} <span class="text-[9px] text-[#8b949e]">PCU</span></span>
                        </div>
                        <div class="flex flex-col items-end">
                            <span class="text-[#8b949e] text-[8px] uppercase">Delay</span>
                            <span class="text-white font-semibold">${appState.avg_delay_seconds.toFixed(1)}s</span>
                        </div>
                    </div>
                </div>
            `;
            approachesContainer.insertAdjacentHTML('beforeend', html);
        }
    });

    // AURA Decision & Saturation
    const bp = jState.aura.back_pressure_multiplier || 1.0;
    const bpElem = document.getElementById('drawer-backpressure');
    if (bp < 0.8) {
        bpElem.textContent = `HIGH CONGESTION (BP: ${bp.toFixed(2)})`;
        bpElem.className = "font-mono text-[#EF4444] font-bold bg-[#EF4444]/10 px-2 py-0.5 rounded border border-[#EF4444]/30";
    } else {
        bpElem.textContent = "NOMINAL CAPACITY (BP: 1.00)";
        bpElem.className = "font-mono text-[#10B981] font-bold bg-[#10B981]/10 px-2 py-0.5 rounded border border-[#10B981]/30";
    }

    document.getElementById('drawer-explanation').textContent = generateAuraExplanation(jState);

    // Evidence Provenance
    let primarySource = "SIMULATED";
    let totalPcu = 0;
    dirs.forEach(dir => {
        if (jState.aura.approaches[dir]) {
            if (jState.aura.approaches[dir].source_mode === "LIVE") primarySource = "LIVE";
            else if (jState.aura.approaches[dir].source_mode === "REPLAY" && primarySource !== "LIVE") primarySource = "REPLAY";
            totalPcu += jState.aura.approaches[dir].queue_pcu;
        }
    });

    document.getElementById('ev-source').textContent = primarySource;
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
        return `Downstream saturation detected along arterial corridor. Applied backpressure penalty (x${bp.toFixed(2)}) to meter incoming traffic and prevent spillback.`;
    } else if (maxQ > 20) {
        return `Elevated demand detected on ${bottleneckDir} approach (${maxQ.toFixed(1)} PCU). AURA actively extending green time allocation.`;
    } else {
        return `Corridor flows operating within nominal bounds. AURA synchronizing green wave progression across adjacent junctions.`;
    }
}

// -------------------------------------------------------------
// Green Wave Progression Panel (Bottom-Left)
// -------------------------------------------------------------
function updateGreenWavePanel(gwData) {
    const grid = document.getElementById('green-wave-grid');
    if (!grid || !gwData) return;
    
    grid.innerHTML = '';
    
    Object.keys(gwData).forEach(jid => {
        const data = gwData[jid];
        const isGreen = data.state === "GREEN";
        const stateColor = isGreen ? "text-[#10B981] bg-[#10B981]/10 border-[#10B981]/30" : "text-[#EF4444] bg-[#EF4444]/10 border-[#EF4444]/30";
        
        const html = `
            <div class="bg-[#161b22] border border-[#30363d] rounded p-2 flex justify-between items-center shadow-sm">
                <span class="text-[10px] font-mono font-bold text-white">${jid}</span>
                <span class="text-[9px] font-mono font-semibold text-[#8b949e]">${data.offset}s</span>
                <span class="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${stateColor}">${data.state}</span>
            </div>
        `;
        grid.insertAdjacentHTML('beforeend', html);
    });
}

// -------------------------------------------------------------
// Provenance / Data Source Badge Update
// -------------------------------------------------------------
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
        dataSourceLabel.textContent = "DATA: LIVE VISION";
        dataSourceLabel.className = "text-[10px] font-mono font-bold px-2.5 py-1 rounded border border-[#10B981]/50 bg-[#10B981]/20 text-[#10B981]";
    } else if (hasReplay) {
        dataSourceLabel.textContent = "DATA: REPLAY VIDEO";
        dataSourceLabel.className = "text-[10px] font-mono font-bold px-2.5 py-1 rounded border border-[#F59E0B]/50 bg-[#F59E0B]/20 text-[#F59E0B]";
    } else {
        dataSourceLabel.textContent = "DATA: SIMULATED";
        dataSourceLabel.className = "text-[10px] font-mono font-bold px-2.5 py-1 rounded bg-[#161b22] text-[#8b949e] border border-[#30363d]";
    }
}

// -------------------------------------------------------------
// User View (Curated Kochi Landmarks & Driver Routing)
// -------------------------------------------------------------
function populateRoutingSelects(graphData) {
    const dest = document.getElementById('user-destination');
    dest.innerHTML = '';
    
    const defaultOpt = new Option('Select destination landmark / area...', '');
    defaultOpt.disabled = true;
    defaultOpt.selected = true;
    dest.add(defaultOpt);
    
    // Curated general destinations with verified node IDs
    const categories = {
        'Major Kochi Landmarks & Areas': [
            { name: "Marine Drive Promenade", node: "1907420158" },
            { name: "Lulu Mall, Edappally", node: "11045741068" },
            { name: "MG Road Commercial Corridor", node: "271145619" },
            { name: "Jawaharlal Nehru Stadium, Kaloor", node: "3672338454" },
            { name: "Vyttila Mobility Hub", node: "2923377480" },
            { name: "Kakkanad Civil Station / IT Corridor", node: "5755272898" },
            { name: "Maharajas College Ground, Ernakulam", node: "5880290979" },
            { name: "Kadavanthra Junction", node: "11347887161" },
            { name: "Palarivattom Bypass", node: "11199503227" },
            { name: "Edappally Toll Bypass", node: "10755951935" },
            { name: "Centre Square Mall, MG Road", node: "277108181" },
            { name: "Oberon Mall, Edappally", node: "11187362500" },
            { name: "High Court of Kerala, Marine Drive", node: "1907385207" }
        ],
        'Transit Hubs & Railway Stations': [
            { name: "Ernakulam Junction (South Railway Station)", node: "277167594" },
            { name: "Ernakulam Town (North Railway Station)", node: "2440749520" },
            { name: "Vyttila Bus & Water Metro Terminal", node: "2923377480" }
        ],
        'Hospitals & Emergency Medical Centers': [
            { name: "Lisie Hospital, Kaloor", node: "4333445844" },
            { name: "Medical Trust Hospital, MG Road", node: "277166730" },
            { name: "Amrita Hospital, Edappally", node: "1474149187" },
            { name: "Aster Medcity, Cheranallur", node: "7500689834" }
        ]
    };

    // Also include any other hospital POIs with "Hospital" in their name
    if (graphData.pois) {
        const extraHospitals = graphData.pois.filter(p => /hospital/i.test(p.name));
        extraHospitals.forEach(p => {
            const alreadyInList = categories['Hospitals & Emergency Medical Centers'].some(h => h.name.includes(p.name));
            if (!alreadyInList && categories['Hospitals & Emergency Medical Centers'].length < 15) {
                categories['Hospitals & Emergency Medical Centers'].push({ name: p.name, node: p.nearestNode });
            }
        });
    }

    Object.keys(categories).forEach(catName => {
        const items = categories[catName];
        if (items.length > 0) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = catName;
            items.forEach(item => {
                const opt = new Option(item.name, item.node);
                optgroup.appendChild(opt);
            });
            dest.appendChild(optgroup);
        }
    });
}

function setOriginLocation(lat, lng) {
    store.userOriginLat = lat;
    store.userOriginLng = lng;
    
    if (userOriginMarker && map.hasLayer(userOriginMarker)) map.removeLayer(userOriginMarker);
    
    userOriginMarker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: 'user-origin-pin',
            html: `
                <div class="flex items-center justify-center w-6 h-6 rounded-full bg-[#10B981] border-2 border-white shadow-xl">
                    <span class="text-[9px] font-bold text-white">A</span>
                </div>
            `,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        })
    }).addTo(map);
    userOriginMarker.bindTooltip("📍 START LOCATION", { permanent: true, direction: "top", className: "aura-tooltip" }).openTooltip();
    
    const disp = document.getElementById('origin-display');
    disp.classList.remove('hidden');
    disp.className = "text-xs font-mono text-[#10B981] px-3 py-2 bg-[#10B981]/10 rounded border border-[#10B981]/30";
    disp.textContent = `Origin: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function setDestinationLocation(lat, lng) {
    store.userDest = { lat, lng };
    
    if (userDestMarker && map.hasLayer(userDestMarker)) map.removeLayer(userDestMarker);
    
    userDestMarker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: 'user-dest-pin',
            html: `
                <div class="flex items-center justify-center w-6 h-6 rounded-full bg-[#EF4444] border-2 border-white shadow-xl">
                    <span class="text-[9px] font-bold text-white">B</span>
                </div>
            `,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        })
    }).addTo(map);
    userDestMarker.bindTooltip("🎯 DESTINATION", { permanent: true, direction: "top", className: "aura-tooltip" }).openTooltip();
    
    const destSelect = document.getElementById('user-destination');
    destSelect.value = '';
    
    const destDisp = document.getElementById('dest-display');
    destDisp.classList.remove('hidden');
    destDisp.textContent = `Map Destination: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

document.getElementById('btn-use-location').addEventListener('click', () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            setOriginLocation(pos.coords.latitude, pos.coords.longitude);
            map.flyTo([pos.coords.latitude, pos.coords.longitude], 14);
        }, () => {
            // Default to near Edappally (10.0242, 76.3084)
            setOriginLocation(10.0242, 76.3084);
            map.flyTo([10.0242, 76.3084], 14);
        });
    } else {
        setOriginLocation(10.0242, 76.3084);
        map.flyTo([10.0242, 76.3084], 14);
    }
});

document.getElementById('btn-map-origin').addEventListener('click', () => {
    isMapOriginSelectionMode = true;
    isMapDestSelectionMode = false;
    document.getElementById('map').style.cursor = 'crosshair';
    const disp = document.getElementById('origin-display');
    disp.classList.remove('hidden');
    disp.className = "text-xs font-mono text-[#F59E0B] px-3 py-2 bg-[#F59E0B]/10 rounded border border-[#F59E0B]/30";
    disp.textContent = "Click anywhere on a Kochi road to set START point.";
});

document.getElementById('btn-map-dest').addEventListener('click', () => {
    isMapDestSelectionMode = true;
    isMapOriginSelectionMode = false;
    document.getElementById('map').style.cursor = 'crosshair';
    const destDisp = document.getElementById('dest-display');
    destDisp.classList.remove('hidden');
    destDisp.className = "text-xs font-mono text-[#F59E0B] px-3 py-1.5 bg-[#F59E0B]/10 rounded border border-[#F59E0B]/30 mt-1";
    destDisp.textContent = "Click anywhere on a Kochi road to set DESTINATION.";
});

document.getElementById('user-destination').addEventListener('change', (e) => {
    store.userDest = e.target.value;
    document.getElementById('dest-display').classList.add('hidden');
    if (userDestMarker && map.hasLayer(userDestMarker)) {
        map.removeLayer(userDestMarker);
        userDestMarker = null;
    }
});

document.getElementById('btn-user-route').addEventListener('click', () => {
    if (!store.userOriginLat || !store.userOriginLng) {
        alert("Please set a starting location first.");
        return;
    }
    
    let dest = store.userDest || document.getElementById('user-destination').value;
    if (!dest) {
        alert("Please choose a destination first.");
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
    if (!map.hasLayer(routingLayer)) {
        routingLayer.addTo(map);
    }
    routingLayer.clearLayers();
    if (!store.graph) return;

    const allPoints = [];

    // Draw Fast path (dashed amber)
    if (fastData && fastData.geometry && fastData.geometry.length > 0) {
        L.polyline(fastData.geometry, {
            color: '#F59E0B',
            weight: 4,
            opacity: 0.75,
            dashArray: '8, 8',
            lineCap: 'round'
        }).addTo(routingLayer);
        fastData.geometry.forEach(pt => allPoints.push(pt));
    }

    // Draw AURA path (solid glowing green with neon core)
    if (auraData && auraData.geometry && auraData.geometry.length > 0) {
        // Outer glow
        L.polyline(auraData.geometry, {
            color: '#10B981',
            weight: 10,
            opacity: 0.35,
            lineCap: 'round'
        }).addTo(routingLayer);

        // Bright core
        L.polyline(auraData.geometry, {
            color: '#34D399',
            weight: 5,
            opacity: 1.0,
            lineCap: 'round'
        }).addTo(routingLayer);

        auraData.geometry.forEach(pt => allPoints.push(pt));
    }

    if (allPoints.length > 0) {
        map.fitBounds(allPoints, { padding: [70, 70], maxZoom: 15 });
    }
}

function handleRouteResult(data) {
    if (data.error) {
        alert(data.error);
        return;
    }
    const resultsContainer = document.getElementById('user-route-results');
    resultsContainer.classList.remove('hidden');

    const aura = data.aura;
    const fast = data.individual;

    // Format junctions passed without internal technical labels
    const auraJuncs = aura.controlledJunctionsPassed.map(j => `<span class="px-2 py-0.5 bg-[#161b22] border border-[#30363d] rounded text-white text-[10px] font-semibold">${j.name}</span>`).join(' ➔ ');
    const fastJuncs = fast.controlledJunctionsPassed.map(j => j.name).join(' → ');

    document.getElementById('aura-time').textContent = `${Math.ceil(aura.estimatedTime / 60)} min`;
    document.getElementById('aura-path').innerHTML = auraJuncs || "<span class='text-[#8b949e]'>Direct Arterial (No Bottlenecks)</span>";
    document.getElementById('aura-explanation').textContent = aura.explanation || "AURA cooperative routing applied.";
    
    document.getElementById('fast-time').textContent = `${Math.ceil(fast.estimatedTime / 60)} min`;
    document.getElementById('fast-path').textContent = fastJuncs ? `Corridors: ${fastJuncs}` : "Direct Shortest Route";
    document.getElementById('fast-explanation').textContent = fast.explanation || "Shortest direct path without cooperative network smoothing.";
    
    // Draw destination pin if not already placed
    if (aura.geometry && aura.geometry.length > 0) {
        const endPt = aura.geometry[aura.geometry.length - 1];
        if (!userDestMarker) {
            userDestMarker = L.marker([endPt[0], endPt[1]], {
                icon: L.divIcon({
                    className: 'user-dest-pin',
                    html: `
                        <div class="flex items-center justify-center w-6 h-6 rounded-full bg-[#EF4444] border-2 border-white shadow-xl">
                            <span class="text-[9px] font-bold text-white">B</span>
                        </div>
                    `,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                })
            }).addTo(map);
            userDestMarker.bindTooltip("🎯 DESTINATION", { permanent: true, direction: "top", className: "aura-tooltip" });
        }
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

// -------------------------------------------------------------
// WebSocket Live Telemetry Connection
// -------------------------------------------------------------
ws.onopen = () => {
    connectionStatus.textContent = "● CONNECTED";
    connectionStatus.className = "text-[10px] font-mono font-bold text-[#10B981] px-2.5 py-1 rounded bg-[#161b22] border border-[#10B981]/30";
};

ws.onclose = () => {
    connectionStatus.textContent = "● DISCONNECTED";
    connectionStatus.className = "text-[10px] font-mono font-bold text-[#EF4444] px-2.5 py-1 rounded bg-[#161b22] border border-[#EF4444]/30";
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
        console.error("WebSocket payload error", e);
    }
};
