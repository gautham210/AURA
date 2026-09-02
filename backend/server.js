const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { SimulationSensor, HybridSensor } = require('./trafficSensors');
const { TrafficEngine, BaselineController } = require('./trafficEngine');
const { RoutingEngine } = require('./routingEngine');
const { DemoTrafficController } = require('./demoTrafficController');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dashboard.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const graphPath = path.join(__dirname, 'graph.json');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));

const simSensor = new SimulationSensor("AURA_DEMO_SEED");
// 2 second timeout for vision
const sensor = new HybridSensor(simSensor, 2000); 

const junctionIds = graph.controlledJunctions.map(j => j.id);
const approaches = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];
const phases = [["NORTHBOUND", "SOUTHBOUND"], ["EASTBOUND", "WESTBOUND"]];

const engineConfig = { C: 60, lost_time: 6, G_min: 10, gap_out_seconds: 5, S: 0.5 };
const aura = new TrafficEngine(engineConfig);
const baseline = new BaselineController(engineConfig);
const routingEngine = new RoutingEngine(graph);

let latestNetworkState = [];
const demoController = new DemoTrafficController(aura, graph);

junctionIds.forEach(jid => {
    aura.initJunction(jid, phases);
    baseline.initJunction(jid, phases);
});

let latestVisionTelemetry = {
    active: false,
    junction_id: null,
    approach_direction: null,
    detections: {},
    arrival_pcu: 0,
    scene_pcu: 0,
    tracked_count: 0,
    source_mode: "SIMULATED",
    lastSeen: 0
};

// Vision endpoint (UVH-26 CCTV Replay Ingestion)
app.post('/vision-update', (req, res) => {
    if (!req.body || !req.body.data) {
        return res.status(400).json({ error: "Missing data payload" });
    }
    const { junction_id, approach_direction, detections, calculated_pcu, scene_pcu, tracked_count, source_mode } = req.body.data;
    const mode = source_mode || "REPLAY";
    sensor.injectVisionData(junction_id, approach_direction, { counts: detections || {} }, mode);

    let pcu = calculated_pcu;
    if (pcu === undefined && detections) {
        pcu = aura.calculatePCU(detections);
    }

    latestVisionTelemetry = {
        active: true,
        junction_id: junction_id,
        approach_direction: approach_direction,
        detections: detections || {},
        arrival_pcu: +(Number(pcu || 0).toFixed(1)),
        scene_pcu: scene_pcu !== undefined ? +(Number(scene_pcu).toFixed(1)) : +(Number(pcu || 0).toFixed(1)),
        tracked_count: tracked_count || 0,
        source_mode: mode,
        lastSeen: Date.now()
    };

    res.json({ 
        status: 'ok', 
        junction_id, 
        approach_direction, 
        source_mode: mode, 
        arrival_pcu: latestVisionTelemetry.arrival_pcu,
        scene_pcu: latestVisionTelemetry.scene_pcu 
    });
});

let connectedClients = new Set();
demoController.onEmergencyUpdate = (state) => {
    const message = JSON.stringify({
        event: "EMERGENCY_UPDATE",
        timestamp: new Date().toISOString(),
        data: state
    });
    for (const client of connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
};


const CYCLE_LENGTH = 60;
const PROGRESSION_SPEED = 10; // m/s
let cumulativeDistance = 0;
const greenWaveOffsets = {};

graph.controlledJunctions.forEach(j => {
    greenWaveOffsets[j.id] = Math.round(cumulativeDistance / PROGRESSION_SPEED) % CYCLE_LENGTH;
    cumulativeDistance += j.distanceToNext || 0;
});

function getGreenWaveStates() {
    const cycleClock = Math.floor(Date.now() / 1000) % CYCLE_LENGTH;
    let states = {};
    graph.controlledJunctions.forEach(j => {
        const localTime = (cycleClock - greenWaveOffsets[j.id] + CYCLE_LENGTH) % CYCLE_LENGTH;
        states[j.id] = {
            offset: greenWaveOffsets[j.id],
            state: localTime < 30 ? "GREEN" : "RED"
        };
    });
    return states;
}

wss.on('connection', (ws) => {
    console.log("Client connected");
    connectedClients.add(ws);
    
    ws.on('message', (message) => {
        try {
            const payload = JSON.parse(message);
            if (payload.event === "ROUTE_REQUEST") {
                const routeResult = routingEngine.findRoutes(payload.data.origin, payload.data.destination, latestNetworkState);
                if (routeResult) {
                    ws.send(JSON.stringify({
                        event: "ROUTE_RESULT",
                        timestamp: new Date().toISOString(),
                        data: routeResult
                    }));
                }
            } else if (payload.event === "START_DEMO") {
                demoController.start();
            } else if (payload.event === "PAUSE_DEMO") {
                demoController.pause();
            } else if (payload.event === "RESET_DEMO") {
                demoController.reset();
            } else if (payload.event === "TRIGGER_EMERGENCY") {
                demoController.triggerEmergency(payload.data?.origin);
            }
        } catch (e) {
            console.error("WS error", e);
        }
    });

    ws.send(JSON.stringify({
        event: "GRAPH_DATA",
        timestamp: new Date().toISOString(),
        data: graph
    }));

    ws.on('close', () => {
        console.log("Client disconnected");
        connectedClients.delete(ws);
    });
});

// Simulation Tick (1 Hz)
let tickCounter = 0;
setInterval(() => {
    sensor.tick(junctionIds, approaches);
    tickCounter++;

    let demoArrivals = null;
    if (demoController.active) {
        demoArrivals = demoController.getSimulatedArrivals();
    }

    junctionIds.forEach(jid => {
        let arrivals = {};
        let sourceModes = {};
        
        if (demoController.active) {
            approaches.forEach(appr => {
                const count = (demoArrivals[jid] && demoArrivals[jid][appr]) ? demoArrivals[jid][appr].counts.car : 0;
                arrivals[appr] = { counts: { car: count } };
                sourceModes[appr] = "SIMULATED";
            });
        } else {
            approaches.forEach(appr => {
                const state = sensor.getApproachState(jid, appr);
                arrivals[appr] = { counts: state.counts };
                sourceModes[appr] = state.sourceMode;
            });
        }

        // Mock downstream utilization to test spillback counting over time
        const util = 0.5 + 0.5 * Math.sin(tickCounter * 0.1); 
        aura.updateBackPressure(jid, util); 

        aura.tick(jid, arrivals);
        baseline.tick(jid, arrivals);

        Object.keys(sourceModes).forEach(appr => {
            if (aura.state[jid] && aura.state[jid].approaches[appr]) {
                aura.state[jid].approaches[appr].source_mode = sourceModes[appr];
            }
        });
    });

    const junctionsState = junctionIds.map(jid => {
        const auraState = aura.getJunctionState(jid);
        const counterfactual = baseline.getCounterfactualState(jid);

        approaches.forEach(appr => {
            const sm = aura.state[jid].approaches[appr].source_mode;
            if (auraState.approaches[appr]) auraState.approaches[appr].source_mode = sm;
        });

        auraState.counterfactual = counterfactual;

        return {
            junction_id: jid,
            phase_name: auraState.phase_name,
            current_phase: auraState.current_phase,
            aura: auraState,
            counterfactual: counterfactual
        };
    });

    latestNetworkState = junctionsState;

    const isVisionActive = (Date.now() - latestVisionTelemetry.lastSeen < 2500);
    const visionReplayStatus = {
        active: isVisionActive,
        junction_id: isVisionActive ? latestVisionTelemetry.junction_id : null,
        approach_direction: isVisionActive ? latestVisionTelemetry.approach_direction : null,
        source_mode: isVisionActive ? latestVisionTelemetry.source_mode : "SIMULATED",
        arrival_pcu: isVisionActive ? latestVisionTelemetry.arrival_pcu : 0,
        scene_pcu: isVisionActive ? latestVisionTelemetry.scene_pcu : 0,
        tracked_count: isVisionActive ? latestVisionTelemetry.tracked_count : 0,
        detections: isVisionActive ? latestVisionTelemetry.detections : {},
        lastSeen: latestVisionTelemetry.lastSeen
    };

    const payload = {
        event: "SIMULATED_TRAFFIC_STATE",
        timestamp: new Date().toISOString(),
        data: { 
            junctions: junctionsState,
            green_wave: getGreenWaveStates(),
            vision_replay: visionReplayStatus,
            demo_state: {
                active: demoController.active,
                elapsed: demoController.elapsedSeconds,
                phase: demoController.active 
                    ? (demoController.elapsedSeconds <= 8 ? 'WARM-UP' 
                       : demoController.elapsedSeconds <= 30 ? 'PEAK SURGE' 
                       : demoController.elapsedSeconds <= 50 ? 'MODERATION' 
                       : 'RECOVERY')
                    : 'IDLE'
            }
        }
    };

    const message = JSON.stringify(payload);
    for (const client of connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`AURA Phase 2 server running on http://localhost:${PORT}`);
});
