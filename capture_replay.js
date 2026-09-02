const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000');
let replayCount = 0;

ws.on('open', () => {
    console.log('Connected to WS. Waiting for REPLAY state...');
});

ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if(data.event === 'SIMULATED_TRAFFIC_STATE') {
        const j1 = data.data.junctions.find(j => j.junction_id === 'J1');
        if (j1) {
            const mode = j1.aura.approaches['NORTHBOUND']?.source_mode;
            const pcu = j1.aura.approaches['NORTHBOUND']?.queue_pcu;
            const state = j1.aura.approaches['NORTHBOUND']?.signal_state;
            
            if (mode === 'REPLAY') {
                console.log(`[WS] J1 NORTH: mode=${mode} pcu=${pcu} signal=${state}`);
                replayCount++;
                if (replayCount >= 10) {
                    process.exit(0);
                }
            }
        }
    }
});
