class MinHeap {
    constructor() {
        this.heap = [];
    }

    push(node, priority) {
        this.heap.push({ node, priority });
        this.bubbleUp();
    }

    pop() {
        if (this.isEmpty()) return null;
        const min = this.heap[0];
        const end = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = end;
            this.bubbleDown();
        }
        return min.node;
    }

    isEmpty() {
        return this.heap.length === 0;
    }

    bubbleUp() {
        let idx = this.heap.length - 1;
        const element = this.heap[idx];
        while (idx > 0) {
            let parentIdx = Math.floor((idx - 1) / 2);
            let parent = this.heap[parentIdx];
            if (element.priority >= parent.priority) break;
            this.heap[idx] = parent;
            this.heap[parentIdx] = element;
            idx = parentIdx;
        }
    }

    bubbleDown() {
        let idx = 0;
        const length = this.heap.length;
        const element = this.heap[0];

        while (true) {
            let leftChildIdx = 2 * idx + 1;
            let rightChildIdx = 2 * idx + 2;
            let leftChild, rightChild;
            let swap = null;

            if (leftChildIdx < length) {
                leftChild = this.heap[leftChildIdx];
                if (leftChild.priority < element.priority) {
                    swap = leftChildIdx;
                }
            }

            if (rightChildIdx < length) {
                rightChild = this.heap[rightChildIdx];
                if (
                    (swap === null && rightChild.priority < element.priority) ||
                    (swap !== null && rightChild.priority < leftChild.priority)
                ) {
                    swap = rightChildIdx;
                }
            }

            if (swap === null) break;
            this.heap[idx] = this.heap[swap];
            this.heap[swap] = element;
            idx = swap;
        }
    }
}

class RoutingEngine {
    constructor(graphData) {
        this.graph = graphData;
        this.nominal_speed = 10.0; // 10 m/s default (~36 km/h)
        this.adj = {};
        this.buildAdjacency();
    }

    buildAdjacency() {
        for (let node of this.graph.nodes) {
            this.adj[node.id] = [];
        }
        for (let edge of this.graph.edges) {
            if (!this.adj[edge.from]) {
                this.adj[edge.from] = [];
            }
            this.adj[edge.from].push(edge);
        }
    }

    // Snaps an arbitrary GPS point [lat, lng] to nearest edge in graph
    findNearestEdge(lat, lng) {
        let bestEdge = null;
        let minSqDist = Infinity;
        let projPoint = null;

        for (let edge of this.graph.edges) {
            if (!edge.geometry || edge.geometry.length < 2) continue;
            
            for (let i = 0; i < edge.geometry.length - 1; i++) {
                const [lat1, lng1] = edge.geometry[i];
                const [lat2, lng2] = edge.geometry[i+1];

                const dx = lng2 - lng1;
                const dy = lat2 - lat1;
                const lenSq = dx*dx + dy*dy;

                let t = 0;
                if (lenSq > 0) {
                    t = Math.max(0, Math.min(1, ((lng - lng1)*dx + (lat - lat1)*dy) / lenSq));
                }

                const pLat = lat1 + t * dy;
                const pLng = lng1 + t * dx;

                const distSq = (lat - pLat)*(lat - pLat) + (lng - pLng)*(lng - pLng);
                if (distSq < minSqDist) {
                    minSqDist = distSq;
                    bestEdge = edge;
                    projPoint = [pLat, pLng];
                }
            }
        }
        
        // Convert approx sq degree distance to meters (1 deg ≈ 111320m)
        const distMeters = Math.sqrt(minSqDist) * 111320;
        return { edge: bestEdge, distMeters, projPoint };
    }

    calculateCosts(networkState, edge, isAuraCooperative) {
        // Road-class aware speeds
        let speed = 5.5; // Default ~20 km/h (local/connector)
        
        // If we had OSM tags we'd use them, but we will guess based on name or fallback
        if (edge.name) {
            const nameLower = edge.name.toLowerCase();
            if (nameLower.includes('nh') || nameLower.includes('bypass') || nameLower.includes('national')) {
                speed = 8.3; // Major arterial ~30 km/h
            } else if (nameLower.includes('road') || nameLower.includes('banerji') || nameLower.includes('mahatma')) {
                speed = 7.5; // Urban arterial ~25-30 km/h
            }
        }
        
        let travel_time = edge.distance / speed;
        let signal_delay = 0;
        let congestion_delay = 0;
        let explanation = '';
        
        const cj = this.graph.controlledJunctions.find(j => j.id === edge.to || j.osmNodeId === edge.to);
        const targetJunction = cj ? networkState.find(j => j.junction_id === cj.id) : networkState.find(j => j.junction_id === edge.to);
        
        let queue_pcu = 0;
        let utilization = 0;

        if (targetJunction) {
            // Signal delay just for passing a controlled intersection
            signal_delay = 15; 
            
            if (targetJunction.aura) {
                const approachState = targetJunction.aura.approaches[edge.approachAtTarget] || 
                                      Object.values(targetJunction.aura.approaches)[0];
                if (approachState) {
                    queue_pcu = approachState.queue_pcu || 0;
                    // Congestion delay: ~2s added delay per PCU in queue ahead
                    congestion_delay = queue_pcu * 2.0; 
                    utilization = Math.min(1.0, queue_pcu / 50.0);
                }
            }
        }

        let cost = travel_time + signal_delay + congestion_delay;

        if (isAuraCooperative && targetJunction) {
            // AURA Penalty: heavily penalize routes > 70% saturated to force alternative routing
            let marginal_penalty = 0;
            if (utilization > 0.7) {
                marginal_penalty = travel_time * 5.0; // Huge penalty
                explanation = `Route avoids ${cj ? cj.name : edge.to} due to high saturation (${Math.round(utilization*100)}%)`;
            } else if (utilization > 0.4) {
                marginal_penalty = travel_time * 1.5;
            }
            cost += marginal_penalty;
        }

        return { cost, utilization, explanation, travel_time, signal_delay, congestion_delay, queue_pcu };
    }

    dijkstra(originId, destId, networkState, isAuraCooperative) {
        const dist = {};
        const prev = {};
        const explanations = {};
        const pq = new MinHeap();

        for (let node of this.graph.nodes) {
            dist[node.id] = Infinity;
        }
        
        dist[originId] = 0;
        pq.push(originId, 0);

        while (!pq.isEmpty()) {
            let u = pq.pop();

            if (u === destId) break;

            const neighbors = this.adj[u] || [];
            for (let edge of neighbors) {
                const { cost, explanation } = this.calculateCosts(networkState, edge, isAuraCooperative);
                const alt = dist[u] + cost;
                
                if (alt < dist[edge.to]) {
                    dist[edge.to] = alt;
                    prev[edge.to] = u;
                    pq.push(edge.to, alt);
                    if (explanation) {
                        explanations[edge.to] = explanation;
                    }
                }
            }
        }

        const path = [];
        let curr = destId;
        if (prev[curr] || curr === originId) {
            while (curr) {
                path.unshift(curr);
                curr = prev[curr];
            }
        }

        let totalDistance = 0;
        let finalExplanation = "Fastest available route based on current state.";
        let highestUtil = 0;
        let bottleneckNode = null;
        
        let totalBaseTime = 0;
        let totalSignalDelay = 0;
        let totalCongestionDelay = 0;
        let totalAuraPenalty = 0;

        for (let i = 0; i < path.length - 1; i++) {
            const neighbors = this.adj[path[i]] || [];
            const e = neighbors.find(edge => edge.to === path[i+1]);
            if (e) {
                totalDistance += e.distance;
                const stats = this.calculateCosts(networkState, e, isAuraCooperative);
                if (stats.utilization > highestUtil) {
                    highestUtil = stats.utilization;
                    bottleneckNode = e.to;
                }
                
                totalBaseTime += stats.travel_time;
                totalSignalDelay += stats.signal_delay;
                totalCongestionDelay += stats.congestion_delay;
                
                const pureCost = stats.travel_time + stats.signal_delay + stats.congestion_delay;
                if (stats.cost > pureCost) {
                    totalAuraPenalty += (stats.cost - pureCost);
                }
            }
            if (explanations[path[i+1]]) {
                finalExplanation = explanations[path[i+1]];
            }
        }

        const physicalTravelTime = totalBaseTime + totalSignalDelay + totalCongestionDelay;

        return {
            route: path,
            distance: totalDistance,
            estimatedTime: physicalTravelTime,
            costScore: dist[destId],
            baseTravelTime: totalBaseTime,
            signalDelay: totalSignalDelay,
            congestionDelay: totalCongestionDelay,
            auraPenalty: totalAuraPenalty,
            congestionExposure: highestUtil,
            explanation: finalExplanation,
            bottleneckNode: bottleneckNode
        };
    }

    findRoutes(origin, destination, networkState) {
        if (!origin || !destination) return null;
        
        let originNodeId = origin;
        let projectedStartGeometry = null;

        if (typeof origin === 'string') {
            const cj = this.graph.controlledJunctions.find(j => j.id === origin);
            if (cj) originNodeId = cj.osmNodeId;
        } else if (typeof origin === 'object' && origin.lat && origin.lng) {
            const nearest = this.findNearestEdge(origin.lat, origin.lng);
            if (!nearest.edge || nearest.distMeters > 1000) {
                return { error: "Please choose a starting location on or near a road." };
            }
            originNodeId = nearest.edge.to;
            const targetNode = this.graph.nodes.find(n => n.id === nearest.edge.to);
            if (targetNode && nearest.projPoint) {
                projectedStartGeometry = [nearest.projPoint, [targetNode.lat, targetNode.lng]];
            }
        }

        let destNodeId = destination;
        let projectedEndGeometry = null;

        if (typeof destination === 'string') {
            const cj = this.graph.controlledJunctions.find(j => j.id === destination);
            if (cj) destNodeId = cj.osmNodeId;
        } else if (typeof destination === 'object' && destination.lat && destination.lng) {
            const nearestDest = this.findNearestEdge(destination.lat, destination.lng);
            if (!nearestDest.edge || nearestDest.distMeters > 1000) {
                return { error: "Please choose a destination on or near a road." };
            }
            destNodeId = nearestDest.edge.from;
            const fromNode = this.graph.nodes.find(n => n.id === nearestDest.edge.from);
            if (fromNode && nearestDest.projPoint) {
                projectedEndGeometry = [[fromNode.lat, fromNode.lng], nearestDest.projPoint];
            }
        }
        
        const individual = this.dijkstra(originNodeId, destNodeId, networkState, false);
        const aura = this.dijkstra(originNodeId, destNodeId, networkState, true);

        // Name bottleneck node if it's a controlled junction
        let bNodeName = individual.bottleneckNode;
        const bJunc = this.graph.controlledJunctions.find(j => j.id === individual.bottleneckNode || j.osmNodeId === individual.bottleneckNode);
        if (bJunc) bNodeName = bJunc.name;
        
        if (individual.route.join('->') !== aura.route.join('->')) {
            aura.explanation = `Individual route uses saturated ${bNodeName} (${Math.round(individual.congestionExposure*100)}%). AURA recommends alternative to prevent spillback.`;
        } else {
            aura.explanation = `Same route — network currently has sufficient capacity.`;
        }

        // Return full geometry and POI info for frontend rendering
        const enhanceRoute = (rResult) => {
            let geom = [];
            let totalDistance = 0;
            if (projectedStartGeometry) {
                geom.push(...projectedStartGeometry);
            }
            
            let controlledJunctionsPassed = [];
            for (let i = 0; i < rResult.route.length - 1; i++) {
                const e = (this.adj[rResult.route[i]] || []).find(edge => edge.to === rResult.route[i+1]);
                if (e) {
                    if (e.geometry) geom.push(...e.geometry);
                    totalDistance += (e.distance || 0);
                }
                
                const cj = this.graph.controlledJunctions.find(j => j.osmNodeId === rResult.route[i+1] || j.id === rResult.route[i+1]);
                if (cj) controlledJunctionsPassed.push({ id: cj.id, name: cj.name });
            }
            if (projectedEndGeometry) {
                geom.push(...projectedEndGeometry);
            }
            rResult.geometry = geom;
            rResult.distance = totalDistance > 0 ? totalDistance : rResult.distance;
            rResult.distanceKm = (rResult.distance / 1000).toFixed(1);
            rResult.controlledJunctionsPassed = controlledJunctionsPassed;
            return rResult;
        };

        return { 
            individual: enhanceRoute(individual), 
            aura: enhanceRoute(aura), 
            timestamp: new Date().toISOString() 
        };
    }

    findCorridorEmergencyRoute(originId = 'J3', destPoiId = 'hosp_welcare') {
        const j3 = this.graph.controlledJunctions.find(j => j.id === 'J3');
        const j4 = this.graph.controlledJunctions.find(j => j.id === 'J4');
        const j5 = this.graph.controlledJunctions.find(j => j.id === 'J5');
        const j6 = this.graph.controlledJunctions.find(j => j.id === 'J6');
        const hospital = this.graph.pois.find(p => p.id === destPoiId) || this.graph.pois.find(p => p.id === 'hosp_welcare');

        const waypoints = [
            { id: 'J3', osmNodeId: j3.osmNodeId, name: j3.name, approach: 'NORTHBOUND' },
            { id: 'J4', osmNodeId: j4.osmNodeId, name: j4.name, approach: 'WESTBOUND' },
            { id: 'J5', osmNodeId: j5.osmNodeId, name: j5.name, approach: 'NORTHBOUND' },
            { id: 'J6', osmNodeId: j6.osmNodeId, name: j6.name, approach: 'SOUTHBOUND' },
            { id: hospital.id, osmNodeId: hospital.nearestNode, name: hospital.name }
        ];

        let fullRoute = [];
        let fullGeometry = [];
        let totalDistance = 0;
        const controlledJunctionsPassed = [
            { id: 'J3', name: j3.name, approach: 'NORTHBOUND', junctionNodeId: j3.osmNodeId },
            { id: 'J4', name: j4.name, approach: 'WESTBOUND', junctionNodeId: j4.osmNodeId },
            { id: 'J5', name: j5.name, approach: 'NORTHBOUND', junctionNodeId: j5.osmNodeId },
            { id: 'J6', name: j6.name, approach: 'SOUTHBOUND', junctionNodeId: j6.osmNodeId }
        ];

        for (let i = 0; i < waypoints.length - 1; i++) {
            const seg = this.findRoutes(waypoints[i].osmNodeId, waypoints[i+1].osmNodeId, []);
            if (seg && seg.individual) {
                totalDistance += seg.individual.distance;
                if (i === 0) {
                    fullRoute.push(...seg.individual.route);
                } else {
                    fullRoute.push(...seg.individual.route.slice(1));
                }
                fullGeometry.push(...seg.individual.geometry);
            }
        }

        return {
            hospital: hospital.name,
            hospitalId: hospital.id,
            route: fullRoute,
            geometry: fullGeometry,
            distance: totalDistance,
            distanceKm: (totalDistance / 1000).toFixed(1),
            controlledJunctionsPassed: controlledJunctionsPassed
        };
    }
}

module.exports = { RoutingEngine };
