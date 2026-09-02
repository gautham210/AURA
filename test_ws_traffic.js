const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000');
let ticks = 0;

ws.on('open', () => {
    console.log('Connected to WS. Waiting for traffic state...');
});

ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if(data.event === 'SIMULATED_TRAFFIC_STATE') {
        const j1 = data.data.junctions.find(j => j.junction_id === 'J1');
        if (j1) {
            const mode = j1.aura.approaches['NORTHBOUND']?.source_mode;
            const pcu = j1.aura.approaches['NORTHBOUND']?.queue_pcu;
            const state = j1.aura.approaches['NORTHBOUND']?.signal_state;
            const delay = j1.aura.approaches['NORTHBOUND']?.avg_delay_seconds;
            const phase = j1.current_phase;
            
            console.log(`[WS] J1 NORTH: mode=${mode} pcu=${pcu} signal=${state} phase=${phase} delay=${delay}s`);
            
            ticks++;
            if (ticks >= 30) {
                console.log("Captured 30 ticks. Exiting.");
                process.exit(0);
            }
        }
    }
});

ws.on('error', (err) => console.error(err));
ws.on('close', () => console.log('Closed'));
