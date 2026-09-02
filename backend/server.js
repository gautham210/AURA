const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { SimulationSensor, HybridSensor } = require('./trafficSensors');
const { TrafficEngine, BaselineController } = require('./trafficEngine');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const graphPath = path.join(__dirname, 'graph.json');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));

const simSensor = new SimulationSensor("AURA_DEMO_SEED");
// 2 second timeout for vision
const sensor = new HybridSensor(simSensor, 2000); 

const junctionIds = graph.junctions.map(j => j.id);
const approaches = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];
const phases = [["NORTHBOUND", "SOUTHBOUND"], ["EASTBOUND", "WESTBOUND"]];

const engineConfig = { C: 60, lost_time: 6, G_min: 10, gap_out_seconds: 5, S: 0.5 };
const aura = new TrafficEngine(engineConfig);
const baseline = new BaselineController(engineConfig);

junctionIds.forEach(jid => {
    aura.initJunction(jid, phases);
    baseline.initJunction(jid, phases);
});

// Vision endpoint
app.post('/vision-update', (req, res) => {
    const { junction_id, approach_direction, detections, calculated_pcu, source_mode } = req.body.data;
    
    // Convert new arrivals into "counts" format that calculatePCU expects, or just inject direct PCU?
    // The sensor interface expects 'counts'.
    // If tracking gives us new arrivals, we can inject those directly.
    sensor.injectVisionData(junction_id, approach_direction, { counts: detections }, source_mode || "LIVE");
    
    res.json({ status: 'ok' });
});

let connectedClients = new Set();

const CYCLE_LENGTH = 60;
const PROGRESSION_SPEED = 10; // m/s
let cumulativeDistance = 0;
const greenWaveOffsets = {};

graph.junctions.forEach(j => {
    greenWaveOffsets[j.id] = Math.round(cumulativeDistance / PROGRESSION_SPEED) % CYCLE_LENGTH;
    cumulativeDistance += j.distanceToNext || 0;
});

function getGreenWaveStates() {
    const cycleClock = Math.floor(Date.now() / 1000) % CYCLE_LENGTH;
    let states = {};
    graph.junctions.forEach(j => {
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

    junctionIds.forEach(jid => {
        let arrivals = {};
        let sourceModes = {};
        approaches.forEach(appr => {
            const state = sensor.getApproachState(jid, appr);
            arrivals[appr] = { counts: state.counts };
            sourceModes[appr] = state.sourceMode;
        });

        // Mock downstream utilization to test spillback counting over time
        const util = 0.5 + 0.5 * Math.sin(tickCounter * 0.1); // oscillates between 0 and 1
        aura.updateBackPressure(jid, util); 

        aura.tick(jid, arrivals);
        baseline.tick(jid, arrivals);

        Object.keys(sourceModes).forEach(appr => {
            aura.state[jid].approaches[appr].source_mode = sourceModes[appr];
        });
    });

    const junctionsState = junctionIds.map(jid => {
        const auraState = aura.getJunctionState(jid);
        const baselineState = baseline.getJunctionState(jid);

        approaches.forEach(appr => {
            const sm = aura.state[jid].approaches[appr].source_mode;
            if(auraState.approaches[appr]) auraState.approaches[appr].source_mode = sm;
            if(baselineState.approaches[appr]) baselineState.approaches[appr].source_mode = sm;
        });

        return {
            junction_id: jid,
            current_phase: auraState.current_phase,
            aura: auraState,
            baseline: baselineState
        };
    });

    const payload = {
        event: "SIMULATED_TRAFFIC_STATE",
        timestamp: new Date().toISOString(),
        data: { 
            junctions: junctionsState,
            green_wave: getGreenWaveStates()
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
