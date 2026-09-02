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
        this.emergencyActive = false;
        this.emergencyPreemptions = {}; // { 'J1': 'EMERGENCY_GREEN' }
    }

    updateGraph(graphData) {
        this.graph = graphData;
        initMap(this.graph);
        populateRoutingSelects(this.graph);
        initTrafficParticleEngine();
    }

    updateTrafficState(stateData) {
        this.networkState = stateData.junctions;
        this.greenWave = stateData.green_wave || {};
        
        // Apply active emergency preemption overrides if active
        if (this.emergencyActive && Object.keys(this.emergencyPreemptions).length > 0) {
            this.networkState.forEach(j => {
                if (this.emergencyPreemptions[j.junction_id]) {
                    const dir = this.emergencyPreemptions[j.junction_id];
                    Object.keys(j.aura.approaches).forEach(d => {
                        if (d === dir) {
                            j.aura.approaches[d].signal_state = "GREEN";
                        } else {
                            j.aura.approaches[d].signal_state = "RED";
                        }
                    });
                }
            });
        }

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
let map, corridorLayer, poiLayer, markerLayer, routingLayer, emergencyLayer;
const junctionMarkers = {};
let isMapOriginSelectionMode = false;
let isMapDestSelectionMode = false;
let userOriginMarker = null;
let userDestMarker = null;
let emergencyMarker = null;

// DOM Elements
const tabControlRoom = document.getElementById('tab-control-room');
const tabUserView = document.getElementById('tab-user-view');
const drawerControl = document.getElementById('drawer-control');
const panelUserView = document.getElementById('panel-user-view');
const btnCloseDrawer = document.getElementById('btn-close-drawer');
const btnSimulateEmergency = document.getElementById('btn-simulate-emergency');
const emergencyHud = document.getElementById('emergency-hud');
const dataSourceLabel = document.getElementById('data-source');
const connectionStatus = document.getElementById('connection-status');
const crInsightsPanel = document.getElementById('cr-insights-panel');

// Setup Navigation Tabs
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
        btnSimulateEmergency.classList.remove('hidden');
        
        // Show Control Room Layers
        if (corridorLayer && !map.hasLayer(corridorLayer)) map.addLayer(corridorLayer);
        if (poiLayer && !map.hasLayer(poiLayer)) map.addLayer(poiLayer);
        if (markerLayer && !map.hasLayer(markerLayer)) map.addLayer(markerLayer);
        
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
        btnSimulateEmergency.classList.add('hidden');
        drawerControl.classList.add('translate-x-full');
        highlightMarker(null);
        
        // Hide technical Control Room layers for clean driver UX
        if (corridorLayer && map.hasLayer(corridorLayer)) map.removeLayer(corridorLayer);
        if (poiLayer && map.hasLayer(poiLayer)) map.removeLayer(poiLayer);
        if (markerLayer && map.hasLayer(markerLayer)) map.removeLayer(markerLayer);
        if (emergencyLayer) emergencyLayer.clearLayers();
    }
    
    setTimeout(() => map && map.invalidateSize(), 100);
}

// -------------------------------------------------------------
// Map Initialization (OpenStreetMap Keyless Dark Layer)
// -------------------------------------------------------------
function initMap(graphData) {
    if (map) return;
    
    map = L.map('map', { zoomControl: false }).setView([9.995, 76.305], 12);
    L.control.zoom({ position: 'topright' }).addTo(map);
    
    // Keyless OpenStreetMap standard tiles with high-contrast cybernetic filter
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        className: 'osm-dark-tiles',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    corridorLayer = L.layerGroup().addTo(map);
    poiLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    routingLayer = L.layerGroup().addTo(map);
    emergencyLayer = L.layerGroup().addTo(map);

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

    // 2. Draw Curated ~10 Major Hospitals (Control Room Only)
    drawHospitalPOIs(graphData.pois);

    // 3. Draw Six Controlled Junctions (J1 to J6)
    drawControlledJunctions(graphData.controlledJunctions);
}

// -------------------------------------------------------------
// 10 Major Geographically Distributed Hospitals (Control Room Only)
// -------------------------------------------------------------
function drawHospitalPOIs(pois) {
    if (!pois) return;
    
    // Strict filter: only genuine hospitals
    const hospitals = pois.filter(p => (p.type === 'hospital' || p.type === 'clinic') && /hospital/i.test(p.name));
    
    const badge = document.getElementById('poi-summary-badge');
    if (badge) badge.textContent = `🏥 ${hospitals.length} Major Hospitals`;

    hospitals.forEach(p => {
        const iconHtml = `
            <div class="relative flex items-center justify-center w-6 h-6 rounded-full bg-[#EF4444]/20 border border-[#EF4444] shadow-md transition-transform hover:scale-125">
                <span class="text-xs leading-none">🏥</span>
            </div>
        `;
        
        const icon = L.divIcon({
            className: 'poi-custom-icon',
            html: iconHtml,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        const marker = L.marker([p.lat, p.lng], { icon });
        marker.bindTooltip(`<b>${p.name}</b><br/><span class="text-[#F87171] font-mono text-[9px] uppercase">MAJOR HOSPITAL</span>`, {
            permanent: false,
            direction: 'top',
            className: 'aura-tooltip'
        });

        marker.addTo(poiLayer);
    });
}

// -------------------------------------------------------------
// Controlled Junctions (Exact Intersection Nodes)
// -------------------------------------------------------------
function drawControlledJunctions(junctions) {
    const bounds = [];

    junctions.forEach(j => {
        bounds.push([j.lat, j.lng]);

        const iconHtml = `
            <div class="relative flex items-center justify-center cursor-pointer group" id="marker-${j.id}" style="width:32px; height:32px;">
                <!-- Outer status halo -->
                <div id="marker-halo-${j.id}" class="absolute -inset-1.5 rounded-full border-2 border-[#10B981] opacity-70 transition-all duration-300 pointer-events-none"></div>
                
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
// Real White Traffic Flow Particle Engine (Canvas-based)
// -------------------------------------------------------------
let canvas, ctx;
let trafficStreams = [];

function initTrafficParticleEngine() {
    canvas = document.getElementById('traffic-canvas');
    if (!canvas || !map || !store.graph) return;
    
    ctx = canvas.getContext('2d');
    
    function resizeCanvas() {
        if (!canvas || !map) return;
        const size = map.getSize();
        canvas.width = size.x;
        canvas.height = size.y;
    }
    
    map.on('resize', resizeCanvas);
    map.on('move', () => {});
    resizeCanvas();

    // Build incoming approach road geometries for J1–J6
    trafficStreams = [];
    store.graph.controlledJunctions.forEach(j => {
        const dirs = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];
        dirs.forEach(dir => {
            const edge = store.graph.edges.find(e => 
                (e.to === j.osmNodeId || e.to === j.id) && 
                e.approachAtTarget === dir && 
                e.geometry && e.geometry.length >= 2
            );
            if (edge) {
                // Initialize particle stream along this physical road segment
                const particles = [];
                for (let i = 0; i < 8; i++) {
                    particles.push({
                        progress: Math.random(), // 0 = start of edge, 1 = junction stop line
                        speed: 0.003 + Math.random() * 0.003,
                        laneOffset: (Math.random() - 0.5) * 0.00004
                    });
                }
                trafficStreams.push({
                    junctionId: j.id,
                    approach: dir,
                    geometry: edge.geometry,
                    particles: particles
                });
            }
        });
    });

    requestAnimationFrame(renderTrafficParticles);
}

function renderTrafficParticles() {
    if (!canvas || !ctx || !map) {
        requestAnimationFrame(renderTrafficParticles);
        return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Only render particles in Control Room
    if (store.currentMode === 'CONTROL_ROOM') {
        trafficStreams.forEach(stream => {
            const jState = store.networkState.find(s => s.junction_id === stream.junctionId);
            let appState = null;
            if (jState && jState.aura && jState.aura.approaches) {
                appState = jState.aura.approaches[stream.approach];
            }

            const isGreen = appState ? (appState.signal_state === "GREEN") : true;
            const q = appState ? (appState.queue_pcu || 0) : 5;
            
            // Queue stop boundary: higher queue = longer packed queue line
            const queueStopProgress = Math.max(0.2, 0.95 - (q / 60.0) * 0.6);

            stream.particles.forEach(p => {
                if (isGreen) {
                    // Moving smoothly through intersection
                    p.progress += p.speed;
                    if (p.progress > 1.0) p.progress = 0;
                } else {
                    // Red signal: decelerate and queue up behind stop line
                    if (p.progress < queueStopProgress) {
                        p.progress += p.speed * 0.7;
                    } else if (p.progress < 0.96) {
                        p.progress += p.speed * 0.15; // Slow crawl in queue
                    } else {
                        // Stopped
                    }
                }

                // Interpolate along the road geometry
                const pt = interpolatePolyline(stream.geometry, p.progress);
                if (pt) {
                    const screenPt = map.latLngToContainerPoint([pt[0] + p.laneOffset, pt[1] + p.laneOffset]);
                    
                    // Draw glowing white traffic particle
                    ctx.beginPath();
                    ctx.arc(screenPt.x, screenPt.y, 2.0, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
                    ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
                    ctx.shadowBlur = 3;
                    ctx.fill();
                }
            });
        });
    }

    requestAnimationFrame(renderTrafficParticles);
}

function interpolatePolyline(geom, t) {
    if (!geom || geom.length < 2) return null;
    t = Math.max(0, Math.min(1, t));
    
    const numSegments = geom.length - 1;
    const segIndex = Math.min(Math.floor(t * numSegments), numSegments - 1);
    const segT = (t * numSegments) - segIndex;

    const [lat1, lng1] = geom[segIndex];
    const [lat2, lng2] = geom[segIndex + 1];

    return [
        lat1 + (lat2 - lat1) * segT,
        lng1 + (lng2 - lng1) * segT
    ];
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

        // Update Halo
        if (haloEl) {
            if (store.emergencyPreemptions[j.junction_id]) {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#3B82F6] shadow-[0_0_16px_#3B82F6] opacity-100 animate-pulse";
            } else if (maxQ > 25) {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#EF4444] shadow-[0_0_12px_rgba(239,68,68,0.8)] opacity-90 animate-pulse";
            } else if (maxQ > 10) {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#F59E0B] shadow-[0_0_8px_rgba(245,158,11,0.5)] opacity-80";
            } else {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#10B981] opacity-70";
            }
        }

        // Update Pip
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

    document.getElementById('drawer-jid').textContent = id;
    document.getElementById('drawer-title').textContent = jNode.name;
    document.getElementById('drawer-phase').textContent = `PHASE ${jState.current_phase || jState.aura.current_phase}`;
    
    const activeMovements = jState.aura.current_phase_description || "--";
    document.getElementById('drawer-phase-desc').textContent = `ACTIVE MOVEMENTS: ${activeMovements}`;

    document.getElementById('center-sig-id').textContent = id;
    const dirs = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];
    
    dirs.forEach(dir => {
        const el = document.getElementById(`sig-${dir}`);
        if (el) {
            const appState = jState.aura.approaches[dir];
            if (appState) {
                if (store.emergencyPreemptions[id] === dir) {
                    el.className = "w-5 h-5 rounded-full border border-[#30363d] signal-emergency";
                } else if (appState.signal_state === "GREEN") {
                    el.className = "w-5 h-5 rounded-full border border-[#30363d] signal-green";
                } else {
                    el.className = "w-5 h-5 rounded-full border border-[#30363d] signal-red";
                }
            } else {
                el.className = "w-5 h-5 rounded-full bg-[#21262d] border border-[#30363d]";
            }
        }
    });

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

    if (store.emergencyPreemptions[jState.junction_id]) {
        return `🚨 EMERGENCY VEHICLE CLEARING CORRIDOR. Absolute priority green granted for emergency transit.`;
    } else if (bp < 0.8) {
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
// Emergency Simulation Engine (Control Room Feature)
// -------------------------------------------------------------
btnSimulateEmergency.addEventListener('click', () => {
    if (store.emergencyActive) return;
    startEmergencySimulation();
});

function startEmergencySimulation() {
    if (!store.graph) return;
    store.emergencyActive = true;
    btnSimulateEmergency.disabled = true;
    btnSimulateEmergency.classList.add('opacity-50', 'cursor-not-allowed');

    // Display Emergency HUD immediately
    if (emergencyHud) {
        emergencyHud.classList.remove('hidden');
        document.getElementById('hud-dest-hospital').textContent = "Locating Nearest Emergency Hospital...";
        document.getElementById('hud-eta').textContent = "CALCULATING";
        document.getElementById('hud-status').textContent = "ACQUIRING PRIORITY CORRIDOR...";
    }

    // 1. Pick a realistic random emergency origin in Kochi
    const candidateOrigins = [
        { name: "Palarivattom Bypass", lat: 10.0055, lng: 76.3120 },
        { name: "Edappally Toll", lat: 10.0270, lng: 76.3090 },
        { name: "Kaloor Stadium", lat: 9.9920, lng: 76.2970 },
        { name: "Kakkanad Road", lat: 10.0080, lng: 76.3240 },
        { name: "Vyttila Hub", lat: 9.9650, lng: 76.3210 }
    ];
    const emOrigin = candidateOrigins[Math.floor(Math.random() * candidateOrigins.length)];

    // 2. Curated 10 hospitals
    const hospitals = store.graph.pois.filter(p => /hospital/i.test(p.name));
    if (hospitals.length === 0) return;

    const randomHospital = hospitals[Math.floor(Math.random() * hospitals.length)];
    store.currentEmergencyHospital = randomHospital.name;

    ws.send(JSON.stringify({
        event: "ROUTE_REQUEST",
        isEmergency: true,
        data: {
            origin: { lat: emOrigin.lat, lng: emOrigin.lng },
            destination: randomHospital.nearestNode || { lat: randomHospital.lat, lng: randomHospital.lng }
        }
    }));
}

function handleEmergencyRoute(data) {
    const routeGeom = data.aura.geometry || data.individual.geometry;
    if (!routeGeom || routeGeom.length === 0) {
        endEmergencySimulation();
        return;
    }

    if (!map.hasLayer(emergencyLayer)) {
        emergencyLayer.addTo(map);
    }
    emergencyLayer.clearLayers();

    const juncsPassed = data.aura.controlledJunctionsPassed || [];
    
    // Display Emergency HUD
    if (emergencyHud) {
        emergencyHud.classList.remove('hidden');
        document.getElementById('hud-dest-hospital').textContent = store.currentEmergencyHospital || "🏥 Major Hospital";
        document.getElementById('hud-eta').textContent = `${Math.ceil(data.aura.estimatedTime || 120)}s`;
        document.getElementById('hud-status').textContent = `CLEARING ${juncsPassed.length} AURA JUNCTIONS`;
    }

    // Draw glowing Red/Blue pulsing emergency priority route
    const emPolyline = L.polyline(routeGeom, {
        color: '#EF4444',
        weight: 6,
        opacity: 0.95,
        lineCap: 'round'
    }).addTo(emergencyLayer);

    // Outer emergency siren aura
    L.polyline(routeGeom, {
        color: '#3B82F6',
        weight: 12,
        opacity: 0.45,
        lineCap: 'round'
    }).addTo(emergencyLayer);

    map.fitBounds(emPolyline.getBounds(), { padding: [80, 80] });

    // Spawn Emergency Ambulance Marker (🚑 with pulsing siren)
    const emIcon = L.divIcon({
        className: 'emergency-custom-marker',
        html: `
            <div class="relative flex items-center justify-center w-8 h-8 rounded-full bg-[#EF4444] border-2 border-white shadow-2xl emergency-siren">
                <span class="text-sm">🚑</span>
            </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });

    const startPt = routeGeom[0];
    emergencyMarker = L.marker([startPt[0], startPt[1]], { icon: emIcon }).addTo(emergencyLayer);

    // Physically animate ambulance along the route geometry
    const totalDuration = 14000; // 14 seconds transit animation
    const startTime = performance.now();

    function animateAmbulance(currentTime) {
        if (!store.emergencyActive) return;
        const elapsed = currentTime - startTime;
        const progress = Math.min(1.0, elapsed / totalDuration);

        // Interpolate along route geometry
        const currentCoord = interpolatePolyline(routeGeom, progress);
        if (currentCoord && emergencyMarker) {
            emergencyMarker.setLatLng([currentCoord[0], currentCoord[1]]);

            // Update remaining ETA
            const remainingSecs = Math.max(0, Math.ceil((1 - progress) * (data.aura.estimatedTime || 120)));
            document.getElementById('hud-eta').textContent = `${remainingSecs}s`;

            // Check proximity to controlled junctions for SIGNAL PREEMPTION
            store.graph.controlledJunctions.forEach(j => {
                const distToJunc = getDistanceMeters(currentCoord[0], currentCoord[1], j.lat, j.lng);
                if (distToJunc < 220) {
                    // Preempt this junction: give emergency green
                    store.emergencyPreemptions[j.id] = "NORTHBOUND"; // Give primary passage
                    document.getElementById('hud-status').textContent = `🚨 ${j.id} EMERGENCY GREEN OVERRIDE`;
                } else if (distToJunc > 300 && store.emergencyPreemptions[j.id]) {
                    // Restored after clearing
                    delete store.emergencyPreemptions[j.id];
                }
            });
        }

        if (progress < 1.0) {
            requestAnimationFrame(animateAmbulance);
        } else {
            // Patient delivered
            document.getElementById('hud-status').textContent = "✅ PATIENT DELIVERED — SIGNALS RESTORED";
            document.getElementById('hud-eta').textContent = "0s";
            setTimeout(() => {
                endEmergencySimulation();
            }, 3000);
        }
    }

    requestAnimationFrame(animateAmbulance);
}

function endEmergencySimulation() {
    store.emergencyActive = false;
    store.emergencyPreemptions = {};
    emergencyHud.classList.add('hidden');
    if (emergencyLayer) emergencyLayer.clearLayers();
    emergencyMarker = null;
    btnSimulateEmergency.disabled = false;
    btnSimulateEmergency.classList.remove('opacity-50', 'cursor-not-allowed');
}

function getDistanceMeters(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * 111320;
    const dLng = (lng2 - lng1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
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
        'Major Emergency Hospitals': []
    };

    // Populate 10 major hospitals
    if (graphData.pois) {
        const hospitals = graphData.pois.filter(p => /hospital/i.test(p.name));
        hospitals.forEach(h => {
            categories['Major Emergency Hospitals'].push({ name: h.name, node: h.nearestNode });
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
            map.panTo([pos.coords.latitude, pos.coords.longitude]);
        }, () => {
            setOriginLocation(10.0242, 76.3084);
            map.panTo([10.0242, 76.3084]);
        });
    } else {
        setOriginLocation(10.0242, 76.3084);
        map.panTo([10.0242, 76.3084]);
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

    if (store.emergencyActive) {
        handleEmergencyRoute(data);
        return;
    }

    const resultsContainer = document.getElementById('user-route-results');
    resultsContainer.classList.remove('hidden');

    const aura = data.aura;
    const fast = data.individual;

    const auraJuncs = aura.controlledJunctionsPassed.map(j => `<span class="px-2 py-0.5 bg-[#161b22] border border-[#30363d] rounded text-white text-[10px] font-semibold">${j.name}</span>`).join(' ➔ ');
    const fastJuncs = fast.controlledJunctionsPassed.map(j => j.name).join(' → ');

    // Display realistic travel time and actual distance in km
    const auraMin = Math.ceil(aura.estimatedTime / 60);
    const fastMin = Math.ceil(fast.estimatedTime / 60);
    const distText = aura.distanceKm ? ` (${aura.distanceKm} km)` : '';

    document.getElementById('aura-time').textContent = `${auraMin} min${distText}`;
    document.getElementById('aura-path').innerHTML = auraJuncs || "<span class='text-[#8b949e]'>Direct Arterial (No Bottlenecks)</span>";
    document.getElementById('aura-explanation').textContent = aura.explanation || "AURA cooperative routing applied.";
    
    document.getElementById('fast-time').textContent = `${fastMin} min${distText}`;
    document.getElementById('fast-path').textContent = fastJuncs ? `Corridors: ${fastJuncs}` : "Direct Shortest Route";
    document.getElementById('fast-explanation').textContent = fast.explanation || "Shortest direct path without cooperative network smoothing.";
    
    // Draw destination pin
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
    connectionStatus.className = "text-[10px] font-mono font-bold text-[#10B981] px-2.5 py-1.5 rounded bg-[#161b22] border border-[#10B981]/30";
};

ws.onclose = () => {
    connectionStatus.textContent = "● DISCONNECTED";
    connectionStatus.className = "text-[10px] font-mono font-bold text-[#EF4444] px-2.5 py-1.5 rounded bg-[#161b22] border border-[#EF4444]/30";
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
