const { RoutingEngine } = require('./routingEngine');

class DemoTrafficController {
    constructor(trafficEngine, graphData) {
        this.trafficEngine = trafficEngine;
        this.graph = graphData;
        this.routingEngine = new RoutingEngine(graphData);
        
        this.active = false;
        this.elapsedSeconds = 0;
        this.timerInterval = null;
        
        this.emergency = {
            active: false,
            hospital: null,
            route: null,
            routeGeometry: [],
            totalDistance: 0,
            distanceTraveled: 0,
            speed: 15, // m/s for ambulance
            currentJunctionTarget: null,
            junctionsRemaining: []
        };
        
        this.onEmergencyUpdate = null; // Callback for server.js to broadcast
    }
    
    start() {
        if (this.active) return;
        this.reset();
        this.active = true;
        
        console.log("DEMO SIMULATION STARTED");
        this.timerInterval = setInterval(() => {
            this.tick();
        }, 1000);
    }
    
    pause() {
        this.active = false;
        if (this.timerInterval) clearInterval(this.timerInterval);
        console.log("DEMO SIMULATION PAUSED");
    }
    
    reset() {
        this.pause();
        this.elapsedSeconds = 0;
        this.emergency = {
            active: false,
            hospital: null,
            route: null,
            routeGeometry: [],
            totalDistance: 0,
            distanceTraveled: 0,
            speed: 15,
            currentJunctionTarget: null,
            junctionsRemaining: []
        };
        
        // Reset all emergency preemptions in traffic engine
        this.graph.controlledJunctions.forEach(j => {
            this.trafficEngine.setEmergencyPreemption(j.id, null);
            // Clear queues for reset
            if (this.trafficEngine.state[j.id]) {
                for(const app in this.trafficEngine.state[j.id].approaches) {
                    this.trafficEngine.state[j.id].approaches[app].q = 0;
                }
            }
        });
        
        if (this.onEmergencyUpdate) this.onEmergencyUpdate({ active: false });
        console.log("DEMO SIMULATION RESET");
    }
    
    tick() {
        this.elapsedSeconds++;
        const t = this.elapsedSeconds;
        
        // --- 1. DEMAND GENERATION (happens in getSimulatedArrivals) ---
        
        // --- 2. EMERGENCY TRIGGER (T=35s) ---
        if (t === 35) {
            this.triggerEmergency();
        }
        
        // --- 3. EMERGENCY TRAVEL ---
        if (this.emergency.active) {
            this.processEmergencyMovement();
        }
    }
    
    // Will be called by server.js in its loop
    getSimulatedArrivals() {
        const arrivalsMap = {};
        const t = this.elapsedSeconds;
        if (!this.active) return arrivalsMap;

        let baseDemand = 0;
        if (t >= 0 && t <= 10) baseDemand = 1;
        else if (t > 10 && t <= 60) baseDemand = 3;
        else baseDemand = 1;

        this.graph.controlledJunctions.forEach(j => {
            const junctionState = this.trafficEngine.state[j.id];
            if (!junctionState) return;
            
            arrivalsMap[j.id] = {};
            for (const phase of junctionState.phases) {
                for (const app of phase) {
                    let count = 0;
                    if (Math.random() < 0.7) count = Math.floor(Math.random() * baseDemand) + (baseDemand > 1 ? 1 : 0);
                    if (t > 10 && t <= 35 && (j.id === 'J2' || j.id === 'J3' || j.id === 'J4')) count = 3;
                    
                    arrivalsMap[j.id][app] = { counts: { car: count } };
                }
            }
        });
        return arrivalsMap;
    }
    
    triggerEmergency() {
        console.log("TRIGGERING EMERGENCY SIMULATION");
        
        // Pick a random drivable origin (we will just pick a random graph node that is NOT a hospital)
        const possibleOrigins = this.graph.nodes.filter(n => n.id !== "277170472" && !this.graph.pois.find(p => p.nearestNode === n.id));
        const originNode = possibleOrigins[Math.floor(Math.random() * possibleOrigins.length)];
        
        const hospitals = this.graph.pois.filter(p => p.type === 'hospital' || p.type === 'clinic');
        
        // Find nearest hospital by graph distance
        let bestHospital = null;
        let shortestDist = Infinity;
        let bestRoute = null;
        
        // We just use Dijkstra without network state for finding the closest structurally
        const emptyState = [];
        
        hospitals.forEach(h => {
            const destNode = h.nearestNode;
            if (!destNode) return;
            const res = this.routingEngine.findRoutes(originNode.id, destNode, emptyState);
            if (res && res.individual && res.individual.distance < shortestDist) {
                shortestDist = res.individual.distance;
                bestHospital = h;
                bestRoute = res.individual;
            }
        });
        
        if (!bestHospital || !bestRoute) return;
        
        this.emergency = {
            active: true,
            hospital: bestHospital.name,
            route: bestRoute,
            routeGeometry: bestRoute.geometry || [],
            totalDistance: bestRoute.distance,
            distanceTraveled: 0,
            speed: 15,
            currentJunctionTarget: null,
            junctionsRemaining: [...bestRoute.controlledJunctionsPassed] // { id, name }
        };
        
        // Broadcast start
        if (this.onEmergencyUpdate) {
            this.onEmergencyUpdate({
                active: true,
                hospital: bestHospital.name,
                distanceRemaining: bestRoute.distance,
                geometry: bestRoute.geometry,
                currentPos: bestRoute.geometry.length > 0 ? bestRoute.geometry[0] : [originNode.lat, originNode.lng]
            });
        }
    }
    
    processEmergencyMovement() {
        const em = this.emergency;
        em.distanceTraveled += em.speed;
        
        if (em.distanceTraveled >= em.totalDistance) {
            // Reached destination
            em.active = false;
            if (this.onEmergencyUpdate) this.onEmergencyUpdate({ active: false });
            // Clear all preemptions
            this.graph.controlledJunctions.forEach(j => this.trafficEngine.setEmergencyPreemption(j.id, null));
            return;
        }
        
        // Calculate current lat,lng based on distanceTraveled along routeGeometry
        let currentPos = null;
        let distAccum = 0;
        
        // Helper to get distance between two points
        const dist2D = (p1, p2) => {
            const R = 6371000;
            const dLat = (p2[0]-p1[0])*Math.PI/180;
            const dLon = (p2[1]-p1[1])*Math.PI/180;
            const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(p1[0]*Math.PI/180)*Math.cos(p2[0]*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        };

        for (let i = 0; i < em.routeGeometry.length - 1; i++) {
            const p1 = em.routeGeometry[i];
            const p2 = em.routeGeometry[i+1];
            const segmentDist = dist2D(p1, p2);
            if (distAccum + segmentDist >= em.distanceTraveled) {
                const ratio = (em.distanceTraveled - distAccum) / segmentDist;
                currentPos = [
                    p1[0] + (p2[0] - p1[0]) * ratio,
                    p1[1] + (p2[1] - p1[1]) * ratio
                ];
                break;
            }
            distAccum += segmentDist;
        }
        
        if (!currentPos && em.routeGeometry.length > 0) {
            currentPos = em.routeGeometry[em.routeGeometry.length - 1];
        }
        
        // Check distance to upcoming junctions and trigger preemption
        if (em.junctionsRemaining.length > 0) {
            const nextJunc = em.junctionsRemaining[0];
            const jData = this.graph.controlledJunctions.find(j => j.id === nextJunc.id);
            if (jData) {
                const distToJunc = dist2D(currentPos, [jData.lat, jData.lng]);
                
                if (distToJunc < 250) { // Approaching junction
                    const rNodes = em.route.route;
                    const jIdx = rNodes.findIndex(nid => nid === jData.osmNodeId || nid === jData.id);
                    let approachDir = "NORTHBOUND"; 
                    if (jIdx > 0) {
                        const fromNode = rNodes[jIdx - 1];
                        const edgeIn = this.graph.edges.find(e => e.from === fromNode && e.to === rNodes[jIdx]);
                        if (edgeIn && edgeIn.approachAtTarget) {
                            approachDir = edgeIn.approachAtTarget;
                        }
                    }
                    
                    this.trafficEngine.setEmergencyPreemption(jData.id, approachDir);
                }
                
                if (distToJunc < 30) {
                    em.junctionsRemaining.shift();
                    this.trafficEngine.setEmergencyPreemption(jData.id, null); 
                }
            }
        }
        
        // Broadcast update
        if (this.onEmergencyUpdate) {
            this.onEmergencyUpdate({
                active: true,
                hospital: em.hospital,
                distanceRemaining: em.totalDistance - em.distanceTraveled,
                currentPos: currentPos,
                junctionsRemaining: em.junctionsRemaining.length
            });
        }
    }
}

module.exports = { DemoTrafficController };
