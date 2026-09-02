const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { SimulationSensor } = require('./trafficSensors');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const graphPath = path.join(__dirname, 'graph.json');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));

const sensor = new SimulationSensor("AURA_DEMO_SEED");

const junctionIds = graph.junctions.map(j => j.id);
const approaches = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];

let connectedClients = new Set();

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
setInterval(() => {
    sensor.tick(junctionIds, approaches);

    const junctionsState = junctionIds.map(jid => {
        let approachesState = {};
        approaches.forEach(appr => {
            const state = sensor.getApproachState(jid, appr);
            const pcu = state.counts.two_wheeler * 0.5 + 
                        state.counts.auto_rickshaw * 1.0 + 
                        state.counts.car * 1.0 + 
                        state.counts.bus * 3.0;

            approachesState[appr] = {
                signal_state: Math.random() > 0.5 ? "GREEN" : "RED", 
                queue_pcu: pcu, 
                max_queue_pcu: 25.0, 
                avg_delay_seconds: 15.0, 
                counts: state.counts,
                source_mode: state.sourceMode
            };
        });

        return {
            junction_id: jid,
            current_phase: 1,
            approaches: approachesState
        };
    });

    const payload = {
        event: "SIMULATED_TRAFFIC_STATE",
        timestamp: new Date().toISOString(),
        data: { junctions: junctionsState }
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
    console.log(`AURA Phase 1 server running on http://localhost:${PORT}`);
});
