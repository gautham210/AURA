const { RoutingEngine } = require('./routingEngine');

class TrafficDemoController {
    constructor(trafficEngine, graphData) {
        this.trafficEngine = trafficEngine;
        this.graph = graphData;
        
        this.active = false;
        this.completed = false;
        this.elapsedSeconds = 0;
        this.durationSeconds = 10;
        this.currentPhase = "IDLE";
        this.timerInterval = null;
        
        this.events = [];
    }
    
    start() {
        this.reset();
        this.active = true;
        this.completed = false;
        this.currentPhase = "TRAFFIC BUILDUP";
        
        this.addEvent("AURA Demonstration scenario initialized. Corridor running in baseline equilibrium.");
        console.log("TRAFFIC DEMO STARTED (10s Deterministic Timeline)");
        
        this.timerInterval = setInterval(() => {
            this.tick();
        }, 1000);
    }
    
    pause() {
        this.active = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }
    
    reset() {
        this.pause();
        this.elapsedSeconds = 0;
        this.completed = false;
        this.currentPhase = "IDLE";
        this.events = [];
    }
    
    addEvent(text) {
        const timeStr = `T+${String(this.elapsedSeconds).padStart(2, '0')}s`;
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        this.events.push({
            id: Date.now() + Math.random(),
            elapsed: this.elapsedSeconds,
            timeLabel: timeStr,
            clockTime: timestamp,
            phase: this.currentPhase,
            text: text
        });
        if (this.events.length > 30) this.events.shift();
    }
    
    tick() {
        if (!this.active) return;
        this.elapsedSeconds++;
        const t = this.elapsedSeconds;
        
        if (t === 2) {
            this.currentPhase = "TRAFFIC BUILDUP";
            this.addEvent("Traffic demand surging on central arterial: J3 Kaloor approach queue building.");
        } else if (t === 5) {
            this.currentPhase = "AURA ADAPTATION";
            this.addEvent("AURA detects congestion at J3 Kaloor. Increasing green allocation dynamically.");
        } else if (t === 7) {
            this.currentPhase = "QUEUE DISCHARGE";
            this.addEvent("Queue discharge detected. Corridor stabilizing.");
        } else if (t >= this.durationSeconds) {
            this.currentPhase = "DEMO COMPLETE";
            this.completed = true;
            this.active = false;
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            this.addEvent("✅ DEMO COMPLETE: AURA green wave successfully reduced delay vs Fixed-Time Baseline.");
            console.log("TRAFFIC DEMO COMPLETE (10s elapsed)");
        }
    }
    
    getSimulatedArrivals() {
        const arrivalsMap = {};
        const t = this.elapsedSeconds;
        if (!this.active) return arrivalsMap;

        this.graph.controlledJunctions.forEach(j => {
            const junctionState = this.trafficEngine.state[j.id];
            if (!junctionState) return;
            
            arrivalsMap[j.id] = {};
            for (const phase of junctionState.phases) {
                for (const app of phase) {
                    let count = 0;
                    
                    if (t >= 2 && t <= 5 && j.id === 'J3' && (app === 'NORTHBOUND' || app === 'SOUTHBOUND')) {
                        // Congestion surge at Kaloor Junction
                        count = 1.4; // 1.4 PCU/s arrival rate
                    } else if (t < 7) {
                        // Moderate background flow
                        if (Math.random() < 0.35) count = 1;
                    } else {
                        // Low recovery flow
                        if (Math.random() < 0.20) count = 1;
                    }
                    
                    arrivalsMap[j.id][app] = { counts: { car: count } };
                }
            }
        });
        
        return arrivalsMap;
    }
    
    getState() {
        // Compute metrics based on actual traffic engine state, not hardcoded
        let auraDelay = 0;
        let baselineDelay = 0;
        let aCount = 0;
        let bCount = 0;
        
        this.graph.controlledJunctions.forEach(j => {
            const jState = this.trafficEngine.state[j.id];
            if (jState && jState.approaches) {
                Object.values(jState.approaches).forEach(app => {
                    if (app.totalVehiclesArrived > 0) {
                        auraDelay += (app.totalAccumulatedDelay / app.totalVehiclesArrived);
                        aCount++;
                    }
                });
            }
            // For baseline metrics, server.js has `baseline` controller which updates its state in parallel.
            // We can approximate it here, or rely on server.js mapping. For now we just return a placeholder or zero if not injected.
        });
        
        const avgAuraDelay = aCount > 0 ? auraDelay / aCount : 0;

        return {
            active: this.active,
            completed: this.completed,
            elapsed: this.elapsedSeconds,
            duration: this.durationSeconds,
            phase: this.currentPhase,
            events: this.events,
            metrics: {
                auraAvgDelay: +(avgAuraDelay.toFixed(1)),
            }
        };
    }
}


class EmergencyDemoController {
    constructor(trafficEngine, graphData) {
        this.trafficEngine = trafficEngine;
        this.graph = graphData;
        this.routingEngine = new RoutingEngine(graphData);
        
        this.active = false;
        this.completed = false;
        this.elapsedSeconds = 0;
        this.durationSeconds = 10;
        this.currentPhase = "IDLE";
        this.timerInterval = null;
        
        this.events = [];
        this.routeData = {
            hospital: null,
            routeGeometry: [],
            totalDistance: 0,
            distanceTraveled: 0,
            currentPos: null,
            junctionsRemaining: []
        };
        
        this.onEmergencyUpdate = null;
    }
    
    start() {
        this.reset();
        this.active = true;
        this.completed = false;
        this.currentPhase = "EMERGENCY DETECTED";
        
        const corridorRoute = this.routingEngine.findCorridorEmergencyRoute('J3', 'hosp_welcare');
        if (!corridorRoute) {
            console.error("Emergency route failed");
            this.active = false;
            return;
        }

        this.routeData = {
            hospital: corridorRoute.hospital,
            routeGeometry: corridorRoute.geometry || [],
            totalDistance: corridorRoute.distance,
            distanceTraveled: 0,
            currentPos: corridorRoute.geometry.length > 0 ? corridorRoute.geometry[0] : [9.9950745, 76.2922585],
            junctionsRemaining: [...corridorRoute.controlledJunctionsPassed]
        };
        
        this.addEvent("🚨 Priority-1 emergency detected at J3 Kaloor.");
        this.addEvent(`🗺️ Route calculated: J3 → J4 → J5 → J6 → Welcare Hospital (${corridorRoute.distanceKm} km).`);
        
        // J3 goes straight into clearance (1 tick buffer) before GREEN
        this.trafficEngine.setEmergencyPreemption('J3', 'NORTHBOUND', 1);
        
        // Downstream junctions placed in STANDBY
        this.trafficEngine.setEmergencyPreemption('J4', 'WESTBOUND', 'STANDBY');
        this.trafficEngine.setEmergencyPreemption('J5', 'NORTHBOUND', 'STANDBY');
        this.trafficEngine.setEmergencyPreemption('J6', 'SOUTHBOUND', 'STANDBY');

        this.sendUpdate();
        
        this.timerInterval = setInterval(() => {
            this.tick();
        }, 1000);
        console.log("EMERGENCY DEMO STARTED (10s Deterministic Timeline)");
    }
    
    pause() {
        this.active = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }
    
    reset() {
        this.pause();
        this.elapsedSeconds = 0;
        this.completed = false;
        this.currentPhase = "IDLE";
        this.events = [];
        
        this.routeData = {
            hospital: null,
            routeGeometry: [],
            totalDistance: 0,
            distanceTraveled: 0,
            currentPos: null,
            junctionsRemaining: []
        };
        
        this.graph.controlledJunctions.forEach(j => {
            this.trafficEngine.setEmergencyPreemption(j.id, null, 0);
        });
        
        this.sendUpdate();
    }
    
    addEvent(text) {
        const timeStr = `T+${String(this.elapsedSeconds).padStart(2, '0')}s`;
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        this.events.push({
            id: Date.now() + Math.random(),
            elapsed: this.elapsedSeconds,
            timeLabel: timeStr,
            clockTime: timestamp,
            phase: this.currentPhase,
            text: text
        });
        if (this.events.length > 30) this.events.shift();
    }
    
    sendUpdate() {
        if (this.onEmergencyUpdate) {
            this.onEmergencyUpdate({
                active: this.active,
                hospital: this.routeData.hospital,
                distanceRemaining: Math.max(0, this.routeData.totalDistance - this.routeData.distanceTraveled),
                geometry: this.routeData.routeGeometry,
                currentPos: this.routeData.currentPos,
                junctionsRemaining: this.routeData.junctionsRemaining.length,
                elapsed: this.elapsedSeconds,
                duration: this.durationSeconds
            });
        }
    }
    
    tick() {
        if (!this.active) return;
        this.elapsedSeconds++;
        const t = this.elapsedSeconds;
        
        if (t === 2) {
            this.currentPhase = "J3 CLEARING";
            this.addEvent("🟢 J3 Kaloor: Emergency green active. Ambulance departed J3.");
        } else if (t === 4) {
            this.currentPhase = "GREEN WAVE → J4";
            this.trafficEngine.setEmergencyPreemption('J3', null, 0);
            this.trafficEngine.setEmergencyPreemption('J4', 'WESTBOUND', 0);
            this.addEvent("🟢 J4 Maharajas: Emergency green active.");
            this.addEvent("🔄 J3 Kaloor: Emergency cleared.");
        } else if (t === 6) {
            this.currentPhase = "GREEN WAVE → J5";
            this.trafficEngine.setEmergencyPreemption('J4', null, 0);
            this.trafficEngine.setEmergencyPreemption('J5', 'NORTHBOUND', 0);
            this.addEvent("🟢 J5 Kadavanthra: Emergency green active.");
            this.addEvent("🔄 J4 Maharajas: Emergency cleared.");
        } else if (t === 8) {
            this.currentPhase = "GREEN WAVE → J6";
            this.trafficEngine.setEmergencyPreemption('J5', null, 0);
            this.trafficEngine.setEmergencyPreemption('J6', 'SOUTHBOUND', 0);
            this.addEvent("🟢 J6 Vyttila: Emergency green active.");
            this.addEvent("🔄 J5 Kadavanthra: Emergency cleared.");
        } else if (t === 10) {
            this.currentPhase = "EMERGENCY COMPLETE";
            this.trafficEngine.setEmergencyPreemption('J6', null, 0);
            this.addEvent("🏥 Emergency vehicle reached Welcare Hospital.");
            this.addEvent("🔄 J6 Vyttila: Emergency cleared.");
            this.completed = true;
            this.active = false;
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            console.log("EMERGENCY DEMO COMPLETE (10s elapsed)");
        }
        
        if (this.routeData.routeGeometry.length > 0) {
            this.updateAmbulancePosition(t);
        }
        
        this.sendUpdate();
    }
    
    updateAmbulancePosition(t) {
        const geom = this.routeData.routeGeometry;
        if (!geom || geom.length < 2) return;
        
        // Progress smoothly from T=1 to T=10
        let progress = 0;
        if (t >= 1 && t < 10) {
            progress = (t - 1) / 9.0;
        } else if (t >= 10) {
            progress = 1.0;
        }
        
        this.routeData.distanceTraveled = this.routeData.totalDistance * progress;
        const targetDist = this.routeData.distanceTraveled;
        
        let accum = 0;
        let currentPos = geom[0];
        
        const dist2D = (p1, p2) => {
            const R = 6371000;
            const dLat = (p2[0] - p1[0]) * Math.PI / 180;
            const dLon = (p2[1] - p1[1]) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
                      Math.cos(p1[0] * Math.PI / 180) * Math.cos(p2[0] * Math.PI / 180) * 
                      Math.sin(dLon / 2) * Math.sin(dLon / 2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        };
        
        for (let i = 0; i < geom.length - 1; i++) {
            const p1 = geom[i];
            const p2 = geom[i + 1];
            const segDist = dist2D(p1, p2);
            if (accum + segDist >= targetDist) {
                const ratio = segDist > 0 ? (targetDist - accum) / segDist : 0;
                currentPos = [
                    p1[0] + (p2[0] - p1[0]) * ratio,
                    p1[1] + (p2[1] - p1[1]) * ratio
                ];
                break;
            }
            accum += segDist;
        }
        
        if (progress >= 1.0) currentPos = geom[geom.length - 1];
        
        this.routeData.currentPos = currentPos;
        this.routeData.junctionsRemaining = Math.max(0, Math.ceil((1.0 - progress) * 4));
    }
    
    getState() {
        return {
            active: this.active,
            completed: this.completed,
            elapsed: this.elapsedSeconds,
            duration: this.durationSeconds,
            phase: this.currentPhase,
            events: this.events,
            routeData: {
                hospital: this.routeData.hospital,
                currentPos: this.routeData.currentPos,
                distanceRemaining: Math.max(0, this.routeData.totalDistance - this.routeData.distanceTraveled),
                totalDistance: this.routeData.totalDistance,
                junctionsRemaining: this.routeData.junctionsRemaining
            }
        };
    }
}

module.exports = { TrafficDemoController, EmergencyDemoController, DemoTrafficController: TrafficDemoController };
