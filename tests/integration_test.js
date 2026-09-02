const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000');
let graphReceived = false;
let tickCount = 0;
let demoStarted = false;
let demoReset = false;

ws.on('open', () => {
    console.log('✓ WebSocket connected');
});

ws.on('message', (data) => {
    try {
        const payload = JSON.parse(data);
        
        if (payload.event === 'GRAPH_DATA' && !graphReceived) {
            graphReceived = true;
            const g = payload.data;
            console.log(`✓ GRAPH_DATA received: ${g.controlledJunctions.length} junctions, ${g.nodes.length} nodes, ${g.edges.length} edges`);
        }
        
        if (payload.event === 'SIMULATED_TRAFFIC_STATE') {
            tickCount++;
            if (tickCount === 1) {
                console.log(`✓ First SIMULATED_TRAFFIC_STATE received`);
                const j = payload.data.junctions;
                console.log(`  Junctions in state: ${j.map(x=>x.junction_id).join(', ')}`);
                const j1 = j.find(x => x.junction_id === 'J1');
                if (j1 && j1.aura && j1.aura.approaches) {
                    const dirs = Object.keys(j1.aura.approaches);
                    console.log(`  J1 approaches: ${dirs.join(', ')}`);
                    dirs.forEach(d => {
                        const a = j1.aura.approaches[d];
                        console.log(`    ${d}: signal=${a.signal_state || a.signalState}, q=${a.queue_pcu || a.q}, source=${a.source_mode || 'N/A'}`);
                    });
                }
            }
            if (tickCount === 3 && !demoStarted) {
                console.log(`✓ 3 ticks received, simulation ticking normally`);
                console.log('  Sending START_DEMO...');
                ws.send(JSON.stringify({ event: 'START_DEMO' }));
                demoStarted = true;
            }
            if (tickCount === 8 && !demoReset) {
                console.log(`✓ 5 ticks after START_DEMO, server still alive`);
                console.log('  Sending RESET_DEMO...');
                ws.send(JSON.stringify({ event: 'RESET_DEMO' }));
                demoReset = true;
            }
            if (tickCount === 11) {
                console.log(`✓ 3 ticks after RESET_DEMO, server still alive`);
                console.log('\n=== ALL INTEGRATION CHECKS PASSED ===');
                ws.close();
                process.exit(0);
            }
        }
        
        if (payload.event === 'EMERGENCY_UPDATE') {
            console.log(`✓ EMERGENCY_UPDATE received: active=${payload.data.active}`);
        }
    } catch(e) {
        console.error('✗ Parse error:', e.message);
    }
});

ws.on('error', (err) => {
    console.error('✗ WebSocket error:', err.message);
    process.exit(1);
});

ws.on('close', () => {
    console.log('WebSocket closed');
});

// Timeout safety
setTimeout(() => {
    console.error('✗ TIMEOUT: Did not complete within 20 seconds');
    process.exit(1);
}, 20000);
