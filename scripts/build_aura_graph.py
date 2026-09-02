import osmnx as ox
import json
import math
import os

west, south, east, north = 76.27, 9.94, 76.33, 10.05

def get_bearing(lat1, lon1, lat2, lon2):
    dLon = (lon2 - lon1)
    y = math.sin(math.radians(dLon)) * math.cos(math.radians(lat2))
    x = math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) - \
        math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(dLon))
    brng = math.atan2(y, x)
    brng = math.degrees(brng)
    return (brng + 360) % 360

def bearing_to_approach(brng):
    # Determines AURA approach based on arriving vehicle heading
    if brng >= 315 or brng < 45: return "SOUTHBOUND"
    elif 45 <= brng < 135: return "WESTBOUND"
    elif 135 <= brng < 225: return "NORTHBOUND"
    else: return "EASTBOUND"

def distance(lat1, lon1, lat2, lon2):
    return (lat1 - lat2)**2 + (lon1 - lon2)**2

def find_nearest_node(G, lat, lng):
    min_dist = float('inf')
    best_node = None
    for n, data in G.nodes(data=True):
        dist = distance(lat, lng, data['y'], data['x'])
        if dist < min_dist:
            min_dist = dist
            best_node = n
    return best_node

print("Downloading graph for AURA...")
G = ox.graph.graph_from_bbox(bbox=(west, south, east, north), network_type='drive')
print(f"Graph loaded. Nodes: {len(G.nodes)}, Edges: {len(G.edges)}")

print("Extracting POIs...")
tags = {'amenity': ['hospital', 'clinic', 'police', 'fire_station']}
pois = ox.features.features_from_bbox(bbox=(west, south, east, north), tags=tags)
print(f"Found {len(pois)} POIs.")

aura_graph = {
    "nodes": [],
    "edges": [],
    "controlledJunctions": [],
    "pois": []
}

# 1. Map known AURA junctions to explicit, verified OSM node IDs.
known_junctions = {
    "J1": {"name": "Edappally Junction", "osm_node_id": 2607681371}, 
    "J2": {"name": "Palarivattom Junction", "osm_node_id": 11199503227},
    "J3": {"name": "Kaloor Junction", "osm_node_id": 5189960535}, 
    "J4": {"name": "Maharajas College Junction", "osm_node_id": 277170472},
    "J5": {"name": "Kadavanthra Junction", "osm_node_id": 11347887161}, 
    "J6": {"name": "Vyttila Junction", "osm_node_id": 1906724170} 
}

# Invert for fast lookup
controlled_node_ids = {v['osm_node_id']: k for k, v in known_junctions.items()}

for jid, data in known_junctions.items():
    node_id = data['osm_node_id']
    if node_id in G.nodes:
        n_data = G.nodes[node_id]
        aura_graph["controlledJunctions"].append({
            "id": jid,
            "name": data["name"],
            "osmNodeId": str(node_id),
            "lat": n_data['y'],
            "lng": n_data['x'],
            "distanceToNext": 2000,
            "approaches": {}
        })
    else:
        print(f"WARNING: Node {node_id} for {jid} not found in graph!")

# 2. Nodes
for n, data in G.nodes(data=True):
    aura_graph["nodes"].append({
        "id": str(n),
        "lat": data['y'],
        "lng": data['x']
    })

# 3. Edges
edge_count = 0
for u, v, k, data in G.edges(keys=True, data=True):
    geom = []
    if 'geometry' in data:
        for coord in data['geometry'].coords:
            geom.append([coord[1], coord[0]])
    else:
        geom = [
            [G.nodes[u]['y'], G.nodes[u]['x']],
            [G.nodes[v]['y'], G.nodes[v]['x']]
        ]
        
    length = data.get('length', 10.0)
    brng = get_bearing(G.nodes[u]['y'], G.nodes[u]['x'], G.nodes[v]['y'], G.nodes[v]['x'])
    approach = bearing_to_approach(brng)
    
    aura_graph["edges"].append({
        "id": f"edge_{edge_count}",
        "from": str(u),
        "to": str(v),
        "distance": length,
        "geometry": geom,
        "approachAtTarget": approach,
        "is_aura_corridor": False
    })
    
    if v in controlled_node_ids:
        jid = controlled_node_ids[v]
        for cj in aura_graph["controlledJunctions"]:
            if cj["id"] == jid:
                cj["approaches"][approach] = True
                
    edge_count += 1

# 3.5 Calculate AURA Managed Corridors
print("Calculating AURA Corridors...")
import networkx as nx
# Generate shortest paths between adjacent controlled junctions
# We will define a logical chain: J1 -> J2 -> J3, and J4 -> J5 -> J6, etc.
# J1 Edappally, J2 Palarivattom, J3 Kaloor
# J4 Maharajas, J5 Kadavanthra, J6 Vyttila
# Meaningful connections to trace:
corridor_pairs = [("J1", "J2"), ("J2", "J3"), ("J4", "J5"), ("J5", "J6"), ("J3", "J5")]

corridor_edges = set()
for j_start, j_end in corridor_pairs:
    u = known_junctions[j_start]['osm_node_id']
    v = known_junctions[j_end]['osm_node_id']
    try:
        path = nx.shortest_path(G, u, v, weight='length')
        for i in range(len(path) - 1):
            corridor_edges.add((str(path[i]), str(path[i+1])))
    except nx.NetworkXNoPath:
        pass

for edge in aura_graph["edges"]:
    if (edge["from"], edge["to"]) in corridor_edges:
        edge["is_aura_corridor"] = True

# 4. POIs
for idx, row in pois.iterrows():
    centroid = row.geometry.centroid if not row.geometry.geom_type == 'Point' else row.geometry
    lat = centroid.y
    lng = centroid.x
    name = row.get('name', 'Unnamed POI')
    poi_type = row.get('amenity', 'poi')
    
    if str(name) != "nan" and name != 'Unnamed POI':
        nearest = find_nearest_node(G, lat, lng)
        aura_graph["pois"].append({
            "poi_id": f"poi_{idx[1]}",
            "name": name,
            "type": poi_type,
            "lat": lat,
            "lng": lng,
            "nearestNode": str(nearest)
        })

for cj in aura_graph["controlledJunctions"]:
    actual = list(cj["approaches"].keys())
    cj["activeApproaches"] = actual

os.makedirs(os.path.join(os.path.dirname(__file__), '..', 'backend'), exist_ok=True)
out_path = os.path.join(os.path.dirname(__file__), '..', 'backend', 'graph.json')
with open(out_path, 'w') as f:
    json.dump(aura_graph, f)

print(f"Graph written to {out_path} with {len(aura_graph['controlledJunctions'])} controlled junctions and {len(aura_graph['pois'])} POIs.")
