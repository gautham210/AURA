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
        this.currentEmergencyHospital = null;
    }

    updateGraph(graphData) {
        this.graph = graphData;
        initMap(this.graph);
        populateRoutingSelects(this.graph);
    }

    updateTrafficState(stateData) {
        this.networkState = stateData.junctions || [];
        this.greenWave = stateData.green_wave || {};
        this.visionReplay = stateData.vision_replay || { active: false };
        
        updateTopMetrics(this.networkState);
        updateMapMarkers(this.networkState);
        updateGreenWavePanel(this.greenWave);
        updateDataSourceLabel(this.networkState);

        // Update Header CCTV Replay Badge
        const badgeReplay = document.getElementById('badge-cctv-replay');
        const targetReplay = document.getElementById('cctv-replay-target');
        if (badgeReplay && this.visionReplay) {
            if (this.visionReplay.active) {
                badgeReplay.classList.remove('hidden');
                badgeReplay.classList.add('flex');
                if (targetReplay) {
                    targetReplay.textContent = `${this.visionReplay.junction_id || 'J1'} ${this.visionReplay.approach_direction || 'NORTHBOUND'}`;
                }
            } else {
                badgeReplay.classList.add('hidden');
                badgeReplay.classList.remove('flex');
            }
        }
        
        if (this.currentMode === 'CONTROL_ROOM' && this.selectedJunctionId) {
            renderJunctionDetail(this.selectedJunctionId);
        }
        
        // Update Demo Operations Console & Status Badges
        this.latestTrafficDemoState = stateData.traffic_demo_state;
        this.latestEmergencyDemoState = stateData.emergency_demo_state;
        updateDemoOperationsConsole(this.latestTrafficDemoState);
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
let emergencyPolyline = null;
let emergencyGlowPolyline = null;

// Safe DOM Elements
const tabControlRoom = document.getElementById('tab-control-room');
const tabUserView = document.getElementById('tab-user-view');
const drawerControl = document.getElementById('drawer-control');
const panelUserView = document.getElementById('panel-user-view');
const btnCloseDrawer = document.getElementById('btn-close-drawer');

const emergencyHud = document.getElementById('emergency-hud');
const dataSourceLabel = document.getElementById('data-source');
const connectionStatus = document.getElementById('connection-status');
const crInsightsPanel = document.getElementById('cr-insights-panel');

const btnSimulateEmergency = document.getElementById('btn-simulate-emergency');
const btnDemoStart = document.getElementById('btn-demo-start');
const btnDemoPause = document.getElementById('btn-demo-pause');
const btnDemoReset = document.getElementById('btn-demo-reset');

// Setup Navigation Tabs
if (tabControlRoom) tabControlRoom.addEventListener('click', () => switchMode('CONTROL_ROOM'));
if (tabUserView) tabUserView.addEventListener('click', () => switchMode('USER_VIEW'));
if (btnCloseDrawer) {
    btnCloseDrawer.addEventListener('click', () => {
        if (drawerControl) drawerControl.classList.add('translate-x-full');
        store.selectedJunctionId = null;
        highlightMarker(null);
    });
}

function switchMode(mode) {
    store.currentMode = mode;
    const adminControls = document.getElementById('admin-controls');
    
    if (mode === 'CONTROL_ROOM') {
        if (tabControlRoom) tabControlRoom.className = "text-xs font-bold px-3 py-1.5 rounded-md border border-[#3B82F6] bg-[#1E3A8A]/30 text-[#60A5FA] transition-all flex items-center gap-1.5 shadow-sm";
        if (tabUserView) tabUserView.className = "text-xs font-semibold px-3 py-1.5 rounded-md border border-transparent text-[#8b949e] hover:text-[#f0f6fc] hover:bg-[#21262d] transition-all flex items-center gap-1.5";
        
        if (panelUserView) panelUserView.classList.add('hidden');
        if (crInsightsPanel) crInsightsPanel.classList.remove('hidden');
        const topMetrics = document.getElementById('top-metrics');
        if (topMetrics) topMetrics.classList.remove('hidden');
        
        // Restore admin controls
        if (adminControls) adminControls.classList.remove('hidden');
        
        // Restore Demo Operations Console if demo is running or completed
        const demoConsole = document.getElementById('demo-console');
        if (demoConsole && store.latestTrafficDemoState && (store.latestTrafficDemoState.active || store.latestTrafficDemoState.completed)) {
            demoConsole.classList.remove('hidden');
        }
        
        // Show Control Room Layers
        if (corridorLayer && map && !map.hasLayer(corridorLayer)) map.addLayer(corridorLayer);
        if (poiLayer && map && !map.hasLayer(poiLayer)) map.addLayer(poiLayer);
        if (markerLayer && map && !map.hasLayer(markerLayer)) map.addLayer(markerLayer);
        
        // Clean User View Markers
        if (userOriginMarker && map && map.hasLayer(userOriginMarker)) map.removeLayer(userOriginMarker);
        if (userDestMarker && map && map.hasLayer(userDestMarker)) map.removeLayer(userDestMarker);
        if (routingLayer) routingLayer.clearLayers();
        
        if (store.selectedJunctionId && drawerControl) {
            drawerControl.classList.remove('translate-x-full');
        }
    } else {
        if (tabControlRoom) tabControlRoom.className = "text-xs font-semibold px-3 py-1.5 rounded-md border border-transparent text-[#8b949e] hover:text-[#f0f6fc] hover:bg-[#21262d] transition-all flex items-center gap-1.5";
        if (tabUserView) tabUserView.className = "text-xs font-bold px-3 py-1.5 rounded-md border border-[#3B82F6] bg-[#1E3A8A]/30 text-[#60A5FA] transition-all flex items-center gap-1.5 shadow-sm";
        
        if (panelUserView) panelUserView.classList.remove('hidden');
        if (crInsightsPanel) crInsightsPanel.classList.add('hidden');
        const topMetrics = document.getElementById('top-metrics');
        if (topMetrics) topMetrics.classList.add('hidden');
        
        // Hide admin controls and Demo Operations Console in User View
        if (adminControls) adminControls.classList.add('hidden');
        const demoConsole = document.getElementById('demo-console');
        if (demoConsole) demoConsole.classList.add('hidden');
        
        if (drawerControl) drawerControl.classList.add('translate-x-full');
        highlightMarker(null);
        
        // Hide technical Control Room layers for clean driver UX
        if (corridorLayer && map && map.hasLayer(corridorLayer)) map.removeLayer(corridorLayer);
        if (poiLayer && map && map.hasLayer(poiLayer)) map.removeLayer(poiLayer);
        if (markerLayer && map && map.hasLayer(markerLayer)) map.removeLayer(markerLayer);
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
    
    // OpenStreetMap standard tiles with CSS dark inversion filter (keyless, free)
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

    // 1. Draw AURA Corridors (Real OSM Road Geometry)
    if (graphData && graphData.edges) {
        graphData.edges.forEach(edge => {
            if (edge.is_aura_corridor && edge.geometry && edge.geometry.length > 0) {
                // Glow underlay for visual dominance
                L.polyline(edge.geometry, {
                    color: '#1E40AF',
                    weight: 8,
                    opacity: 0.35,
                    lineCap: 'round',
                    lineJoin: 'round'
                }).addTo(corridorLayer);
                // Main corridor line
                L.polyline(edge.geometry, {
                    color: '#3B82F6',
                    weight: 4,
                    opacity: 0.9,
                    lineCap: 'round',
                    lineJoin: 'round'
                }).addTo(corridorLayer);
            }
        });
    }

    // 2. Draw Curated 10 Major Hospitals (Control Room Only)
    if (graphData && graphData.pois) {
        drawHospitalPOIs(graphData.pois);
    }

    // 3. Draw Six Controlled Junctions (J1 to J6)
    if (graphData && graphData.controlledJunctions) {
        drawControlledJunctions(graphData.controlledJunctions);
    }

    // 4. Initialize Authoritative Traffic Visualizer Canvas
    initTrafficVisualization();
}

// -------------------------------------------------------------
// 10 Major Geographically Distributed Hospitals (Control Room Only)
// -------------------------------------------------------------
function drawHospitalPOIs(pois) {
    if (!pois) return;
    
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
// Authoritative Traffic Visualization (Canvas)
// -------------------------------------------------------------
let canvas, ctx;
function initTrafficVisualization() {
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
    
    requestAnimationFrame(renderTrafficVis);
}

function renderTrafficVis() {
    if (!canvas || !ctx || !map || store.currentMode !== 'CONTROL_ROOM') {
        if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        requestAnimationFrame(renderTrafficVis);
        return;
    }
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (store.networkState && store.graph) {
        store.networkState.forEach(jState => {
            const dirs = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];
            dirs.forEach(dir => {
                const app = jState.aura && jState.aura.approaches ? jState.aura.approaches[dir] : null;
                if (!app) return;
                
                const cj = store.graph.controlledJunctions ? store.graph.controlledJunctions.find(j => j.id === jState.junction_id) : null;
                const targetNodeId = cj ? cj.osmNodeId : jState.junction_id;
                
                // Find approaching edge geometry
                const edge = store.graph.edges.find(e => (e.to === jState.junction_id || e.to === targetNodeId) && e.approachAtTarget === dir && e.geometry);
                if (!edge || !edge.geometry || edge.geometry.length < 2) return;
                
                const geom = edge.geometry;
                const pcu = Math.min(app.queue_pcu || 0, 40);
                if (pcu <= 0) return;
                
                const numVehicles = Math.ceil(pcu);
                const isGreen = app.signal_state === "GREEN";
                
                ctx.fillStyle = isGreen ? "rgba(16, 185, 129, 0.85)" : "rgba(239, 68, 68, 0.85)";
                
                let geomIdx = geom.length - 1;
                let currentPt = geom[geomIdx];
                let prevPt = geom[geomIdx - 1];
                
                for (let i = 0; i < numVehicles; i++) {
                    const offsetProgress = Math.max(0, 1.0 - ((i + 1) * 0.035));
                    const p1Pos = map.latLngToContainerPoint([prevPt[0], prevPt[1]]);
                    const p2Pos = map.latLngToContainerPoint([currentPt[0], currentPt[1]]);
                    
                    const vx = p2Pos.x - p1Pos.x;
                    const vy = p2Pos.y - p1Pos.y;
                    
                    const px = p1Pos.x + vx * offsetProgress;
                    const py = p1Pos.y + vy * offsetProgress;
                    
                    ctx.beginPath();
                    ctx.arc(px, py, 2.0, 0, 2 * Math.PI);
                    ctx.fill();
                }
            });
        });
    }
    
    requestAnimationFrame(renderTrafficVis);
}

// -------------------------------------------------------------
// Real-time Marker & Signal Updates
// -------------------------------------------------------------
function updateMapMarkers(networkState) {
    if (!networkState) return;
    
    networkState.forEach(j => {
        const jm = junctionMarkers[j.junction_id];
        if (!jm || !j.aura) return;

        const haloEl = document.getElementById(jm.haloId);
        const pipEl = document.getElementById(jm.pipId);

        let maxQ = 0;
        let isGreen = false;

        if (j.aura.approaches) {
            Object.values(j.aura.approaches).forEach(app => {
                if (app.queue_pcu > maxQ) maxQ = app.queue_pcu;
                if (app.signal_state === "GREEN") isGreen = true;
            });
        }

        const isEmergency = j.aura.emergency && j.aura.emergency.active;

        // Update Halo
        if (haloEl) {
            if (isEmergency) {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#3B82F6] shadow-[0_0_16px_#3B82F6] opacity-100 animate-pulse";
            } else if (maxQ > 15) {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#EF4444] shadow-[0_0_12px_rgba(239,68,68,0.8)] opacity-90 animate-pulse";
            } else if (maxQ > 6) {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#F59E0B] shadow-[0_0_8px_rgba(245,158,11,0.5)] opacity-80";
            } else {
                haloEl.className = "absolute -inset-1.5 rounded-full border-2 border-[#10B981] opacity-70";
            }
        }

        // Update Pip
        if (pipEl) {
            if (isEmergency) {
                pipEl.className = isGreen
                    ? "absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#10B981] border-2 border-[#3B82F6] shadow-[0_0_8px_#10B981] animate-pulse"
                    : "absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#EF4444] border-2 border-[#3B82F6] shadow-[0_0_8px_#EF4444]";
            } else if (isGreen) {
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
    let maxQueue = 0;
    let totalSpillbacks = 0;

    networkState.forEach(j => {
        if (!j.aura) return;
        totalSpillbacks += j.aura.spillback_events || 0;
        
        if (j.aura.approaches) {
            Object.values(j.aura.approaches).forEach(app => {
                if (app.avg_delay_seconds > 0) {
                    totalDelay += app.avg_delay_seconds;
                    delayCount++;
                }
                if (app.queue_pcu > maxQueue) {
                    maxQueue = app.queue_pcu;
                }
            });
        }
    });

    const avgDelay = delayCount > 0 ? (totalDelay / delayCount).toFixed(1) : "0.0";
    
    const metricDelay = document.getElementById('metric-delay');
    const metricQueue = document.getElementById('metric-queue') || document.getElementById('metric-demand');
    const metricSpillbacks = document.getElementById('metric-spillbacks');

    if (metricDelay) metricDelay.textContent = `${avgDelay}s`;
    if (metricQueue) metricQueue.textContent = `${maxQueue.toFixed(1)} PCU`;
    if (metricSpillbacks) metricSpillbacks.textContent = totalSpillbacks;
}

// -------------------------------------------------------------
// Junction Selection & Detail Drawer
// -------------------------------------------------------------
function selectJunction(id) {
    store.selectedJunctionId = id;
    highlightMarker(id);
    renderJunctionDetail(id);
    if (drawerControl) drawerControl.classList.remove('translate-x-full');
    
    if (store.graph && store.graph.controlledJunctions) {
        const jData = store.graph.controlledJunctions.find(j => j.id === id);
        if (jData && map) {
            map.panTo([jData.lat, jData.lng]);
        }
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
    if (!store.graph || !store.networkState) return;
    const jNode = store.graph.controlledJunctions ? store.graph.controlledJunctions.find(j => j.id === id) : null;
    const jState = store.networkState.find(s => s.junction_id === id);
    if (!jNode || !jState || !jState.aura) return;

    const jidEl = document.getElementById('drawer-jid');
    const titleEl = document.getElementById('drawer-title');
    const phaseEl = document.getElementById('drawer-phase');
    const phaseDescEl = document.getElementById('drawer-phase-desc');
    const centerSigId = document.getElementById('center-sig-id');

    if (jidEl) jidEl.textContent = id;
    if (titleEl) titleEl.textContent = jNode.name;
    
    const isEm = jState.aura.emergency && jState.aura.emergency.active;
    if (phaseEl) {
        if (isEm) {
            phaseEl.textContent = `EMERGENCY: ${jState.aura.emergency.state}`;
            phaseEl.className = "px-2 py-0.5 bg-[#EF4444]/20 text-[#EF4444] font-bold rounded border border-[#EF4444]/40 animate-pulse";
        } else {
            phaseEl.textContent = `PHASE ${jState.aura.current_phase || jState.current_phase || 1}`;
            phaseEl.className = "px-2 py-0.5 bg-[#3B82F6]/20 text-[#60A5FA] font-bold rounded border border-[#3B82F6]/30";
        }
    }
    
    if (phaseDescEl) {
        if (isEm) {
            phaseDescEl.textContent = `PRIORITY CORRIDOR: ${jState.aura.emergency.approach || 'CLEARING'}`;
        } else {
            phaseDescEl.textContent = `ACTIVE MOVEMENTS: ${jState.aura.current_phase_description || '--'}`;
        }
    }

    if (centerSigId) centerSigId.textContent = id;
    const dirs = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];
    
    dirs.forEach(dir => {
        const el = document.getElementById(`sig-${dir}`);
        if (el && jState.aura.approaches) {
            const appState = jState.aura.approaches[dir];
            if (appState) {
                if (isEm && jState.aura.emergency.approach === dir && jState.aura.emergency.state === 'EMERGENCY_GREEN') {
                    el.className = "w-5 h-5 rounded-full border-2 border-[#3B82F6] signal-green";
                } else if (isEm && jState.aura.emergency.state === 'CLEARING') {
                    el.className = "w-5 h-5 rounded-full border border-[#30363d] signal-amber";
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
    if (approachesContainer && jState.aura.approaches) {
        approachesContainer.innerHTML = '';
        
        dirs.forEach(dir => {
            const appState = jState.aura.approaches[dir];
            if (appState) {
                const isGreen = appState.signal_state === "GREEN";
                const isReplay = appState.source_mode === "REPLAY";
                const sigBadge = isGreen ? "bg-[#10B981]/20 text-[#10B981] border-[#10B981]/40" : "bg-[#EF4444]/20 text-[#EF4444] border-[#EF4444]/40";
                const modeBadge = isReplay 
                    ? "bg-[#3B82F6]/20 text-[#60A5FA] border-[#3B82F6]/50 animate-pulse font-bold" 
                    : (appState.source_mode === "LIVE" ? "text-[#10B981]" : "text-[#8b949e]");
                const rowBorder = isReplay 
                    ? "border-[#3B82F6]/60 shadow-[0_0_10px_rgba(59,130,246,0.25)] bg-[#0d1117]" 
                    : "border-[#30363d] bg-[#0d1117]";

                const html = `
                    <div class="${rowBorder} border rounded-md p-2.5 flex justify-between items-center shadow-sm">
                        <div class="flex items-center gap-2.5">
                            <span class="text-[10px] font-mono font-bold text-[#8b949e] w-14">${dir.substring(0,5)}</span>
                            <span class="text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${sigBadge}">${appState.signal_state}</span>
                            <span class="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded border ${modeBadge}">${appState.source_mode || 'SIM'}</span>
                        </div>
                        <div class="flex items-center gap-4 font-mono text-xs">
                            <div class="flex flex-col items-end">
                                <span class="text-[#8b949e] text-[8px] uppercase">Queue</span>
                                <span class="text-white font-semibold">${(appState.queue_pcu || 0).toFixed(1)} <span class="text-[9px] text-[#8b949e]">PCU</span></span>
                            </div>
                            <div class="flex flex-col items-end">
                                <span class="text-[#8b949e] text-[8px] uppercase">Delay</span>
                                <span class="text-white font-semibold">${(appState.avg_delay_seconds || 0).toFixed(1)}s</span>
                            </div>
                        </div>
                    </div>
                `;
                approachesContainer.insertAdjacentHTML('beforeend', html);
            }
        });
    }

    const bp = jState.aura.back_pressure_multiplier || 1.0;
    const bpElem = document.getElementById('drawer-backpressure');
    if (bpElem) {
        if (bp < 0.8) {
            bpElem.textContent = `HIGH CONGESTION (BP: ${bp.toFixed(2)})`;
            bpElem.className = "font-mono text-[#EF4444] font-bold bg-[#EF4444]/10 px-2 py-0.5 rounded border border-[#EF4444]/30";
        } else {
            bpElem.textContent = "NOMINAL CAPACITY (BP: 1.00)";
            bpElem.className = "font-mono text-[#10B981] font-bold bg-[#10B981]/10 px-2 py-0.5 rounded border border-[#10B981]/30";
        }
    }

    const expElem = document.getElementById('drawer-explanation');
    if (expElem) expElem.textContent = generateAuraExplanation(jState);

    let primarySource = "SIMULATED";
    let totalPcu = 0;
    let hasReplayAppr = false;
    if (jState.aura.approaches) {
        dirs.forEach(dir => {
            const a = jState.aura.approaches[dir];
            if (a) {
                if (a.source_mode === "LIVE") primarySource = "LIVE";
                else if (a.source_mode === "REPLAY") {
                    primarySource = "REPLAY";
                    hasReplayAppr = true;
                }
                totalPcu += (a.queue_pcu || 0);
            }
        });
    }

    const evBadge = document.getElementById('ev-badge');
    const evSource = document.getElementById('ev-source');
    const evApproach = document.getElementById('ev-approach');
    const evModel = document.getElementById('ev-model');
    const evScenePcu = document.getElementById('ev-scene-pcu');
    const evPcu = document.getElementById('ev-pcu');

    const vr = store.visionReplay;
    const isJ1ReplayActive = (id === 'J1' && (hasReplayAppr || (vr && vr.active && vr.junction_id === 'J1')));

    if (isJ1ReplayActive) {
        if (evBadge) {
            evBadge.textContent = "REPLAY (ACTIVE)";
            evBadge.className = "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#3B82F6]/20 text-[#60A5FA] border border-[#3B82F6]/40 animate-pulse";
        }
        if (evSource) evSource.textContent = "REPLAY (vision/traffic.mp4)";
        if (evApproach) evApproach.textContent = "NORTHBOUND (Assigned to J1)";
        if (evModel) evModel.textContent = "UVH-26 YOLOv11-S + ByteTrack";
        
        const trackedCount = (vr && vr.active && vr.tracked_count) ? vr.tracked_count : 30;
        const scenePcuVal = (vr && vr.active && vr.scene_pcu) ? vr.scene_pcu : 35.0;
        const arrivalPcuVal = (vr && vr.active && vr.arrival_pcu !== undefined) ? vr.arrival_pcu : (jState.aura.approaches['NORTHBOUND'] ? jState.aura.approaches['NORTHBOUND'].queue_pcu : 0);
        
        if (evScenePcu) evScenePcu.textContent = `${trackedCount} vehicles (${scenePcuVal.toFixed(1)} Scene PCU)`;
        if (evPcu) evPcu.textContent = `${arrivalPcuVal.toFixed(1)} Arrival PCU (New Batch)`;
    } else {
        if (evBadge) {
            evBadge.textContent = primarySource;
            evBadge.className = "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#21262d] text-[#8b949e] border border-[#30363d]";
        }
        if (evSource) evSource.textContent = primarySource;
        if (evApproach) evApproach.textContent = "ALL (SIMULATED)";
        if (evModel) evModel.textContent = "Synthetic Flow Generator";
        if (evScenePcu) evScenePcu.textContent = `Nominal Flow`;
        if (evPcu) evPcu.textContent = `${totalPcu.toFixed(1)} PCU`;
    }

    // Counterfactual Baseline Benchmark (Offline Reference Comparison Only)
    const cf = jState.counterfactual || (jState.aura && jState.aura.counterfactual);
    const cfDelayEl = document.getElementById('cf-baseline-delay');
    const cfSavingsEl = document.getElementById('cf-aura-savings');
    if (cfDelayEl && cf) {
        cfDelayEl.textContent = `${cf.avg_delay_seconds || 0}s`;
        
        let auraDelay = 0;
        let count = 0;
        if (jState.aura.approaches) {
            Object.values(jState.aura.approaches).forEach(a => {
                if (a.avg_delay_seconds > 0) {
                    auraDelay += a.avg_delay_seconds;
                    count++;
                }
            });
        }
        const avgAura = count > 0 ? (auraDelay / count) : 0;
        const baseDelay = cf.avg_delay_seconds || 1;
        const savings = Math.max(0, Math.min(95, Math.round(((baseDelay - avgAura) / (baseDelay || 1)) * 100)));
        if (cfSavingsEl) {
            cfSavingsEl.textContent = `${savings}% Less Delay`;
        }
    }
}

function generateAuraExplanation(jState) {
    if (jState.aura.emergency && jState.aura.emergency.active) {
        return `🚨 EMERGENCY VEHICLE CLEARING CORRIDOR (${jState.aura.emergency.approach || 'APPROACHING'}). Authoritative priority green active.`;
    }
    
    const bp = jState.aura.back_pressure_multiplier;
    let maxQ = 0;
    let bottleneckDir = "";
    
    if (jState.aura.approaches) {
        Object.keys(jState.aura.approaches).forEach(dir => {
            if (jState.aura.approaches[dir].queue_pcu > maxQ) {
                maxQ = jState.aura.approaches[dir].queue_pcu;
                bottleneckDir = dir;
            }
        });
    }

    if (bp < 0.8) {
        return `Downstream saturation detected along arterial corridor. Applied backpressure penalty (x${bp.toFixed(2)}) to meter incoming traffic and prevent spillback.`;
    } else if (maxQ > 15) {
        return `Elevated demand detected on ${bottleneckDir} approach (${maxQ.toFixed(1)} PCU). AURA dynamically extending green phase.`;
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
    
    if (store.emergencyActive && store.networkState) {
        // Render Emergency Wave Corridor
        const emergencyNodes = ["J3", "J4", "J5", "J6"];
        emergencyNodes.forEach(jid => {
            const jState = store.networkState.find(j => j.junction_id === jid);
            if (!jState || !jState.aura || !jState.aura.emergency) return;
            
            const emState = jState.aura.emergency.state;
            let statusText = "STANDBY";
            let stateColor = "text-[#8b949e] bg-[#30363d]/50 border-[#30363d]/50";
            
            if (emState === "EMERGENCY_GREEN") {
                statusText = "ACTIVE";
                stateColor = "text-[#10B981] bg-[#10B981]/10 border-[#10B981]/30";
            } else if (emState === "RECOVERY" || emState === "NORMAL") {
                // If it was normal but emergency is active, it means it already cleared (or hasn't reached it, but STANDBY handles that)
                statusText = "CLEARED";
                stateColor = "text-[#3B82F6] bg-[#3B82F6]/10 border-[#3B82F6]/30";
            } else if (emState === "CLEARING") {
                statusText = "CLEARING";
                stateColor = "text-[#F59E0B] bg-[#F59E0B]/10 border-[#F59E0B]/30";
            }

            const html = `
                <div class="bg-[#161b22] border border-[#30363d] rounded p-2 flex justify-between items-center shadow-sm">
                    <span class="text-[10px] font-mono font-bold text-white">${jid}</span>
                    <span class="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${stateColor}">${statusText}</span>
                </div>
            `;
            grid.insertAdjacentHTML('beforeend', html);
        });
    } else {
        // Render Normal Progression Offsets
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
}

// -------------------------------------------------------------
// Provenance / Data Source Badge Update
// -------------------------------------------------------------
function updateDataSourceLabel(networkState) {
    if (!dataSourceLabel) return;
    let hasLive = false;
    let hasReplay = false;

    if (networkState) {
        networkState.forEach(j => {
            if (j.aura && j.aura.approaches) {
                Object.values(j.aura.approaches).forEach(app => {
                    if (app.source_mode === "LIVE") hasLive = true;
                    if (app.source_mode === "REPLAY") hasReplay = true;
                });
            }
        });
    }

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
// Geometry / Distance Utility Helpers
// -------------------------------------------------------------
function getDistanceMeters(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * 111320;
    const dLng = (lng2 - lng1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
}

function interpolatePolyline(coords, progress) {
    if (!coords || coords.length === 0) return null;
    if (coords.length === 1 || progress <= 0) return coords[0];
    if (progress >= 1) return coords[coords.length - 1];

    let totalDist = 0;
    const dists = [];
    for (let i = 0; i < coords.length - 1; i++) {
        const d = getDistanceMeters(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1]);
        dists.push(d);
        totalDist += d;
    }

    if (totalDist === 0) return coords[0];

    const targetDist = progress * totalDist;
    let accum = 0;
    for (let i = 0; i < dists.length; i++) {
        if (accum + dists[i] >= targetDist) {
            const segProgress = dists[i] > 0 ? (targetDist - accum) / dists[i] : 0;
            const lat = coords[i][0] + (coords[i+1][0] - coords[i][0]) * segProgress;
            const lng = coords[i][1] + (coords[i+1][1] - coords[i][1]) * segProgress;
            return [lat, lng];
        }
        accum += dists[i];
    }
    return coords[coords.length - 1];
}

// -------------------------------------------------------------
// Emergency Preemption & Live Tracking
// -------------------------------------------------------------
if (btnSimulateEmergency) {
    btnSimulateEmergency.addEventListener('click', () => {
        if (store.emergencyActive) return;
        const scenarioSelect = document.getElementById('select-emergency-scenario');
        const scenario = scenarioSelect ? scenarioSelect.value : 'HEAVY_CONGESTION';
        // Hide any previous results
        const resultsPanel = document.getElementById('emergency-results');
        if (resultsPanel) resultsPanel.classList.add('hidden');
        ws.send(JSON.stringify({ event: "TRIGGER_EMERGENCY", scenario: scenario }));
        btnSimulateEmergency.disabled = true;
        btnSimulateEmergency.classList.add('opacity-50', 'cursor-not-allowed');
        
        // Client-side prediction: instantly hide Traffic Demo console to prevent 1s flicker
        const consoleEl = document.getElementById('demo-console');
        if (consoleEl) consoleEl.classList.add('hidden');
        const demoIndicator = document.getElementById('demo-status-indicator');
        if (demoIndicator) {
            demoIndicator.classList.add('hidden');
            demoIndicator.classList.remove('flex');
        }
        if (btnDemoStart) {
            btnDemoStart.classList.remove('hidden');
            btnDemoStart.innerHTML = `<span>▶</span> START DEMO`;
        }
        if (btnDemoPause) btnDemoPause.classList.add('hidden');
    });
}

function handleEmergencyUpdate(data) {
    if (!data) return;

    if (data.active) {
        store.emergencyActive = true;
        if (btnSimulateEmergency) {
            btnSimulateEmergency.disabled = true;
            btnSimulateEmergency.classList.add('opacity-50', 'cursor-not-allowed');
        }

        if (emergencyHud) {
            emergencyHud.classList.remove('hidden');
            const destEl = document.getElementById('hud-dest-hospital');
            const etaEl = document.getElementById('hud-eta');
            const statusEl = document.getElementById('hud-status');

            if (destEl) destEl.textContent = data.hospital || "🏥 Major Hospital";
            const distKm = ((data.distanceRemaining || 0) / 1000).toFixed(1);
            if (etaEl) {
            const elapsed = data.elapsed || 0;
            const duration = data.duration || 10;
            const simRemaining = Math.max(0, duration - elapsed);
            etaEl.textContent = `T+${elapsed}s / ${duration}s (${distKm} km)`;
        }
        if (statusEl) statusEl.textContent = data.junctionsRemaining > 0 ? `PREEMPTING ${data.junctionsRemaining} AURA JUNCTIONS` : "APPROACHING DESTINATION";
        }

        if (map && emergencyLayer) {
            if (!map.hasLayer(emergencyLayer)) emergencyLayer.addTo(map);

            // Draw route geometry if available and not yet drawn
            if (data.geometry && data.geometry.length > 1 && !emergencyPolyline) {
                // Dominant Red Outer Glow Halo
                emergencyGlowPolyline = L.polyline(data.geometry, {
                    color: '#EF4444',
                    weight: 14,
                    opacity: 0.45,
                    lineCap: 'round',
                    lineJoin: 'round'
                }).addTo(emergencyLayer);

                // High-Contrast Crisp Laser Line
                emergencyPolyline = L.polyline(data.geometry, {
                    color: '#FCA5A5',
                    weight: 5,
                    opacity: 1.0,
                    lineCap: 'round',
                    lineJoin: 'round'
                }).addTo(emergencyLayer);
            }

            // Update Ambulance Marker position
            if (data.currentPos) {
                if (!emergencyMarker) {
                    const emIcon = L.divIcon({
                        className: 'emergency-custom-marker',
                        html: `
                            <div class="relative flex items-center justify-center w-9 h-9 rounded-full bg-[#EF4444] border-2 border-white shadow-[0_0_20px_#EF4444] animate-pulse">
                                <span class="text-sm">🚑</span>
                            </div>
                        `,
                        iconSize: [36, 36],
                        iconAnchor: [18, 18]
                    });
                    emergencyMarker = L.marker(data.currentPos, { icon: emIcon }).addTo(emergencyLayer);
                } else {
                    emergencyMarker.setLatLng(data.currentPos);
                }
            }
        }
    } else {
        // Emergency ended
        store.emergencyActive = false;
        if (emergencyHud) emergencyHud.classList.add('hidden');

        const destEl = document.getElementById('hud-dest-hospital');
        const etaEl = document.getElementById('hud-eta');
        const statusEl = document.getElementById('hud-status');
        if (destEl) destEl.textContent = "--";
        if (etaEl) etaEl.textContent = "--s";
        if (statusEl) statusEl.textContent = "CLEARING CORRIDOR...";

        // Show completion results if available
        if (data.completed && data.completionMetrics) {
            renderEmergencyResults(data.completionMetrics);
        }

        if (btnSimulateEmergency) {
            btnSimulateEmergency.disabled = false;
            btnSimulateEmergency.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }
}

function renderEmergencyResults(m) {
    if (!m) return;
    const panel = document.getElementById('emergency-results');
    if (!panel) return;

    const pctBadge = document.getElementById('em-pct-badge');
    const auraTime = document.getElementById('em-aura-time');
    const baseTime = document.getElementById('em-base-time');
    const auraSig = document.getElementById('em-aura-sig');
    const baseSig = document.getElementById('em-base-sig');
    const auraQ = document.getElementById('em-aura-q');
    const baseQ = document.getElementById('em-base-q');
    const routeInfo = document.getElementById('em-route-info');
    const distInfo = document.getElementById('em-dist-info');

    if (pctBadge) pctBadge.textContent = `${m.percentageSaved}% TIME SAVED`;
    if (auraTime) auraTime.textContent = m.auraTravelTimeFormatted;
    if (baseTime) baseTime.textContent = m.baselineTravelTimeFormatted;
    if (auraSig) auraSig.textContent = `${m.auraSignalDelaySeconds}s`;
    if (baseSig) baseSig.textContent = `${m.baselineSignalDelaySeconds}s`;
    if (auraQ) auraQ.textContent = `${m.auraQueueDelaySeconds}s`;
    if (baseQ) baseQ.textContent = `${m.baselineQueueDelaySeconds}s`;
    if (routeInfo) routeInfo.textContent = m.routePath;
    if (distInfo) distInfo.textContent = `${m.distanceKm} km`;

    panel.classList.remove('hidden');
}

// Dismiss emergency results
const btnDismissResults = document.getElementById('btn-dismiss-results');
if (btnDismissResults) {
    btnDismissResults.addEventListener('click', () => {
        const panel = document.getElementById('emergency-results');
        if (panel) panel.classList.add('hidden');
    });
}

// -------------------------------------------------------------
// Demo Operations Console & Telemetry Renderer
// -------------------------------------------------------------
function getPhaseColor(phase) {
    const colors = {
        'TRAFFIC BUILDUP': '#F59E0B',
        'EMERGENCY DETECTED': '#EF4444',
        'CLEARING J3': '#EF4444',
        'EMERGENCY GREEN J3': '#10B981',
        'GREEN WAVE → J4': '#10B981',
        'CORRIDOR TRANSIT': '#3B82F6',
        'GREEN WAVE → J5': '#10B981',
        'GREEN WAVE → J6': '#10B981',
        'EMERGENCY PASSED': '#3B82F6',
        'RECOVERY': '#F59E0B',
        'DEMO COMPLETE': '#10B981'
    };
    return colors[phase] || '#F59E0B';
}

function updateDemoOperationsConsole(demoState) {
    const consoleEl = document.getElementById('demo-console');
    const timerEl = document.getElementById('demo-console-timer');
    const phaseEl = document.getElementById('demo-console-phase');
    const eventsEl = document.getElementById('demo-console-events');
    const summaryEl = document.getElementById('demo-console-summary');
    const pulseEl = document.getElementById('demo-console-pulse');

    const demoIndicator = document.getElementById('demo-status-indicator');
    const demoStatusText = document.getElementById('demo-status-text');
    const demoElapsed = document.getElementById('demo-elapsed');
    const demoPhaseLabel = document.getElementById('demo-phase-label');

    if (!demoState) return;

    const isRunning = demoState.active;
    const isCompleted = demoState.completed;

    // Header strip indicator
    if (demoIndicator) {
        if (isRunning || isCompleted) {
            demoIndicator.classList.remove('hidden');
            demoIndicator.classList.add('flex');
            if (demoStatusText) {
                demoStatusText.textContent = isCompleted ? "DEMO COMPLETE" : "DEMO RUNNING";
                demoStatusText.className = isCompleted 
                    ? "text-[10px] font-mono font-bold text-[#60A5FA] tracking-wider" 
                    : "text-[10px] font-mono font-bold text-[#10B981] tracking-wider";
            }
            if (demoElapsed) demoElapsed.textContent = `T+${String(demoState.elapsed).padStart(2, '0')}s / ${demoState.duration || 10}s`;
            if (demoPhaseLabel) {
                demoPhaseLabel.textContent = demoState.phase;
                demoPhaseLabel.style.color = getPhaseColor(demoState.phase);
            }
        } else {
            demoIndicator.classList.add('hidden');
            demoIndicator.classList.remove('flex');
        }
    }

    // Button states
    if (btnDemoStart && btnDemoPause) {
        if (isRunning) {
            btnDemoStart.classList.add('hidden');
            btnDemoPause.classList.remove('hidden');
        } else {
            btnDemoStart.classList.remove('hidden');
            btnDemoPause.classList.add('hidden');
            if (isCompleted) {
                btnDemoStart.innerHTML = `<span>↺</span> RESTART DEMO`;
            } else {
                btnDemoStart.innerHTML = `<span>▶</span> START DEMO`;
            }
        }
    }

    // Demo Operations Console
    if (consoleEl) {
        if (store.currentMode === 'CONTROL_ROOM' && (isRunning || isCompleted)) {
            consoleEl.classList.remove('hidden');
            
            if (timerEl) timerEl.textContent = `T+${String(demoState.elapsed).padStart(2, '0')}s / ${demoState.duration || 10}s`;
            if (phaseEl) {
                phaseEl.textContent = demoState.phase;
                phaseEl.style.color = getPhaseColor(demoState.phase);
            }
            if (pulseEl) {
                pulseEl.className = isCompleted 
                    ? "w-2.5 h-2.5 rounded-full bg-[#3B82F6]" 
                    : "w-2.5 h-2.5 rounded-full bg-[#10B981] animate-ping";
            }

            // Render Events
            if (eventsEl && demoState.events && demoState.events.length > 0) {
                eventsEl.innerHTML = demoState.events.map(e => `
                    <div class="py-1 border-b border-[#30363d]/30 flex gap-2 items-start leading-tight">
                        <span class="text-[#8b949e] font-mono text-[10px] shrink-0">${e.timeLabel}</span>
                        <span class="text-[#e6edf3] flex-1">${e.text}</span>
                    </div>
                `).join('');
                eventsEl.scrollTop = eventsEl.scrollHeight;
            }

            // Summary Card on completion
            if (summaryEl) {
                if (isCompleted) {
                    summaryEl.classList.remove('hidden');
                } else {
                    summaryEl.classList.add('hidden');
                }
            }
        } else {
            consoleEl.classList.add('hidden');
        }
    }
}

// -------------------------------------------------------------
// Demo Controls (Start / Pause / Reset)
// -------------------------------------------------------------
const btnCloseDemoConsole = document.getElementById('btn-close-demo-console');
if (btnCloseDemoConsole) {
    btnCloseDemoConsole.addEventListener('click', () => {
        const consoleEl = document.getElementById('demo-console');
        if (consoleEl) consoleEl.classList.add('hidden');
    });
}

if (btnDemoStart) {
    btnDemoStart.addEventListener('click', () => {
        // Mutual exclusion: START_DEMO unconditionally clears any emergency overlay
        if (emergencyHud) emergencyHud.classList.add('hidden');
        if (emergencyLayer) emergencyLayer.clearLayers();
        emergencyMarker = null;
        emergencyPolyline = null;
        emergencyGlowPolyline = null;
        store.emergencyActive = false;
        const destEl = document.getElementById('hud-dest-hospital');
        const etaEl = document.getElementById('hud-eta');
        const statusEl = document.getElementById('hud-status');
        if (destEl) destEl.textContent = "--";
        if (etaEl) etaEl.textContent = "--s";
        if (statusEl) statusEl.textContent = "CLEARING CORRIDOR...";
        if (btnSimulateEmergency) {
            btnSimulateEmergency.disabled = false;
            btnSimulateEmergency.classList.remove('opacity-50', 'cursor-not-allowed');
        }

        ws.send(JSON.stringify({ event: 'START_DEMO' }));
        btnDemoStart.classList.add('hidden');
        if (btnDemoPause) btnDemoPause.classList.remove('hidden');
        const consoleEl = document.getElementById('demo-console');
        if (consoleEl && store.currentMode === 'CONTROL_ROOM') {
            consoleEl.classList.remove('hidden');
        }
    });
}

if (btnDemoPause) {
    btnDemoPause.addEventListener('click', () => {
        ws.send(JSON.stringify({ event: 'PAUSE_DEMO' }));
        btnDemoPause.classList.add('hidden');
        if (btnDemoStart) btnDemoStart.classList.remove('hidden');
    });
}

if (btnDemoReset) {
    btnDemoReset.addEventListener('click', () => {
        ws.send(JSON.stringify({ event: 'RESET_DEMO' }));
        if (btnDemoPause) btnDemoPause.classList.add('hidden');
        if (btnDemoStart) {
            btnDemoStart.classList.remove('hidden');
            btnDemoStart.innerHTML = `<span>▶</span> START DEMO`;
        }
        if (emergencyHud) emergencyHud.classList.add('hidden');
        if (emergencyLayer) emergencyLayer.clearLayers();
        emergencyMarker = null;
        emergencyPolyline = null;
        emergencyGlowPolyline = null;
        store.emergencyActive = false;
        
        const destEl = document.getElementById('hud-dest-hospital');
        const etaEl = document.getElementById('hud-eta');
        const statusEl = document.getElementById('hud-status');
        if (destEl) destEl.textContent = "--";
        if (etaEl) etaEl.textContent = "--s";
        if (statusEl) statusEl.textContent = "CLEARING CORRIDOR...";

        const consoleEl = document.getElementById('demo-console');
        if (consoleEl) consoleEl.classList.add('hidden');
        const summaryEl = document.getElementById('demo-console-summary');
        if (summaryEl) summaryEl.classList.add('hidden');
        
        if (btnSimulateEmergency) {
            btnSimulateEmergency.disabled = false;
            btnSimulateEmergency.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    });
}

// -------------------------------------------------------------
// User View (Curated Kochi Landmarks & Driver Routing)
// -------------------------------------------------------------
function populateRoutingSelects(graphData) {
    const dest = document.getElementById('user-destination');
    if (!dest) return;
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
        ]
    };

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
    
    if (userOriginMarker && map && map.hasLayer(userOriginMarker)) map.removeLayer(userOriginMarker);
    
    if (map) {
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
    }
    
    const disp = document.getElementById('origin-display');
    if (disp) {
        disp.classList.remove('hidden');
        disp.className = "text-xs font-mono text-[#10B981] px-3 py-2 bg-[#10B981]/10 rounded border border-[#10B981]/30";
        disp.textContent = `Origin: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
}

function setDestinationLocation(lat, lng) {
    store.userDest = { lat, lng };
    
    if (userDestMarker && map && map.hasLayer(userDestMarker)) map.removeLayer(userDestMarker);
    
    if (map) {
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
    }
    
    const destSelect = document.getElementById('user-destination');
    if (destSelect) destSelect.value = '';
    
    const destDisp = document.getElementById('dest-display');
    if (destDisp) {
        destDisp.classList.remove('hidden');
        destDisp.textContent = `Map Destination: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
}

const btnUseLocation = document.getElementById('btn-use-location');
if (btnUseLocation) {
    btnUseLocation.addEventListener('click', () => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(pos => {
                setOriginLocation(pos.coords.latitude, pos.coords.longitude);
                if (map) map.panTo([pos.coords.latitude, pos.coords.longitude]);
            }, () => {
                setOriginLocation(10.0242, 76.3084);
                if (map) map.panTo([10.0242, 76.3084]);
            });
        } else {
            setOriginLocation(10.0242, 76.3084);
            if (map) map.panTo([10.0242, 76.3084]);
        }
    });
}

const btnMapOrigin = document.getElementById('btn-map-origin');
if (btnMapOrigin) {
    btnMapOrigin.addEventListener('click', () => {
        isMapOriginSelectionMode = true;
        isMapDestSelectionMode = false;
        const mapEl = document.getElementById('map');
        if (mapEl) mapEl.style.cursor = 'crosshair';
        const disp = document.getElementById('origin-display');
        if (disp) {
            disp.classList.remove('hidden');
            disp.className = "text-xs font-mono text-[#F59E0B] px-3 py-2 bg-[#F59E0B]/10 rounded border border-[#F59E0B]/30";
            disp.textContent = "Click anywhere on a Kochi road to set START point.";
        }
    });
}

const btnMapDest = document.getElementById('btn-map-dest');
if (btnMapDest) {
    btnMapDest.addEventListener('click', () => {
        isMapDestSelectionMode = true;
        isMapOriginSelectionMode = false;
        const mapEl = document.getElementById('map');
        if (mapEl) mapEl.style.cursor = 'crosshair';
        const destDisp = document.getElementById('dest-display');
        if (destDisp) {
            destDisp.classList.remove('hidden');
            destDisp.className = "text-xs font-mono text-[#F59E0B] px-3 py-1.5 bg-[#F59E0B]/10 rounded border border-[#F59E0B]/30 mt-1";
            destDisp.textContent = "Click anywhere on a Kochi road to set DESTINATION.";
        }
    });
}

const userDestSelect = document.getElementById('user-destination');
if (userDestSelect) {
    userDestSelect.addEventListener('change', (e) => {
        store.userDest = e.target.value;
        const destDisp = document.getElementById('dest-display');
        if (destDisp) destDisp.classList.add('hidden');
        if (userDestMarker && map && map.hasLayer(userDestMarker)) {
            map.removeLayer(userDestMarker);
            userDestMarker = null;
        }
    });
}

const btnUserRoute = document.getElementById('btn-user-route');
if (btnUserRoute) {
    btnUserRoute.addEventListener('click', () => {
        if (!store.userOriginLat || !store.userOriginLng) {
            alert("Please set a starting location first (use 'My Location' or 'Pick on Map').");
            return;
        }
        
        let dest = store.userDest || (userDestSelect ? userDestSelect.value : null);
        if (!dest) {
            alert("Please choose a destination landmark or click 'Pick on Map'.");
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
}

function drawRoutePolylines(auraData, fastData) {
    if (!map || !routingLayer) return;
    if (!map.hasLayer(routingLayer)) {
        routingLayer.addTo(map);
    }
    routingLayer.clearLayers();

    const allPoints = [];

    // Draw Direct path (dashed amber)
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

    // Draw AURA Recommended path (solid glowing green with neon core)
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
    if (resultsContainer) resultsContainer.classList.remove('hidden');

    const aura = data.aura;
    const fast = data.individual;
    if (!aura || !fast) return;

    const auraJuncs = (aura.controlledJunctionsPassed || []).map(j => `<span class="px-2 py-0.5 bg-[#161b22] border border-[#30363d] rounded text-white text-[10px] font-semibold">${j.name}</span>`).join(' ➔ ');
    const fastJuncs = (fast.controlledJunctionsPassed || []).map(j => j.name).join(' → ');

    // Display realistic travel time and actual distance in km
    const auraMin = Math.ceil((aura.estimatedTime || 60) / 60);
    const fastMin = Math.ceil((fast.estimatedTime || 60) / 60);
    const distText = aura.distanceKm ? ` (${aura.distanceKm} km)` : '';

    const auraTime = document.getElementById('aura-time');
    const auraPath = document.getElementById('aura-path');
    const auraExplanation = document.getElementById('aura-explanation');
    const fastTime = document.getElementById('fast-time');
    const fastPath = document.getElementById('fast-path');
    const fastExplanation = document.getElementById('fast-explanation');

    if (auraTime) auraTime.textContent = `${auraMin} min${distText}`;
    if (auraPath) auraPath.innerHTML = auraJuncs || "<span class='text-[#8b949e]'>Direct Arterial (No Bottlenecks)</span>";
    if (auraExplanation) auraExplanation.textContent = aura.explanation || "AURA cooperative routing applied.";
    
    if (fastTime) fastTime.textContent = `${fastMin} min${distText}`;
    if (fastPath) fastPath.textContent = fastJuncs ? `Corridors: ${fastJuncs}` : "Direct Shortest Route";
    if (fastExplanation) fastExplanation.textContent = fast.explanation || "Shortest direct path without cooperative network smoothing.";
    
    // Draw destination pin
    if (aura.geometry && aura.geometry.length > 0 && map) {
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
const btnToggleInsights = document.getElementById('btn-toggle-insights');
if (btnToggleInsights) {
    btnToggleInsights.addEventListener('click', () => {
        const content = document.getElementById('insights-content');
        const icon = document.getElementById('cr-insights-icon');
        if (content && icon) {
            if (content.classList.contains('hidden')) {
                content.classList.remove('hidden');
                icon.textContent = '▼';
            } else {
                content.classList.add('hidden');
                icon.textContent = '▲';
            }
        }
    });
}

// -------------------------------------------------------------
// WebSocket Live Telemetry Connection
// -------------------------------------------------------------
ws.onopen = () => {
    if (connectionStatus) {
        connectionStatus.textContent = "● CONNECTED";
        connectionStatus.className = "text-[10px] font-mono font-bold text-[#10B981] px-2.5 py-1.5 rounded bg-[#161b22] border border-[#10B981]/30";
    }
};

ws.onclose = () => {
    if (connectionStatus) {
        connectionStatus.textContent = "● DISCONNECTED";
        connectionStatus.className = "text-[10px] font-mono font-bold text-[#EF4444] px-2.5 py-1.5 rounded bg-[#161b22] border border-[#EF4444]/30";
    }
};

ws.onerror = (err) => {
    console.error("WebSocket error:", err);
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
        } else if (payload.event === "EMERGENCY_UPDATE") {
            handleEmergencyUpdate(payload.data);
        }
    } catch (e) {
        console.error("WebSocket payload error", e);
    }
};
