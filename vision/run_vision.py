import argparse
import time
import requests
import json
import cv2
try:
    from ultralytics import YOLO
except ImportError:
    print("ultralytics not installed. Please run: pip install ultralytics opencv-python requests")
    exit(1)

# Authoritative PCU weights matching AURA TrafficEngine
PCU_WEIGHTS = {
    'Two-wheeler': 0.5, 'bicycle': 0.5, 'two_wheeler': 0.5,
    'Three-wheeler': 1.0, 'auto_rickshaw': 1.0,
    'Hatchback': 1.0, 'Sedan': 1.0, 'SUV': 1.0, 'Van': 1.0, 'Others': 1.0, 'car': 1.0, 'LCV': 1.0,
    'MUV': 3.0, 'Bus': 3.0, 'Truck': 3.0, 'Mini-bus': 3.0, 'tempo-traveller': 3.0, 'bus': 3.0
}

# Distinct colors (BGR) for vehicle classes
CLASS_COLORS = {
    'Two-wheeler': (0, 255, 128),
    'Three-wheeler': (0, 215, 255),
    'bicycle': (0, 255, 0),
    'Hatchback': (255, 178, 50),
    'Sedan': (255, 140, 0),
    'SUV': (238, 104, 123),
    'Van': (200, 200, 0),
    'LCV': (255, 69, 0),
    'Bus': (180, 105, 255),
    'Truck': (147, 20, 255),
    'MUV': (255, 105, 180),
    'Mini-bus': (186, 85, 211),
    'tempo-traveller': (218, 112, 214),
    'Others': (128, 128, 128)
}

def calculate_pcu(counts):
    """Calculate total PCU from a dictionary of class counts."""
    total = 0.0
    for cls_name, count in counts.items():
        weight = PCU_WEIGHTS.get(cls_name, 1.0)
        total += count * weight
    return total

def run():
    parser = argparse.ArgumentParser(description="AURA Vision Pipeline (UVH-26 + ByteTrack)")
    parser.add_argument("--source", type=str, default="0", help="Video source (e.g., path/to/video.mp4 or 0 for webcam)")
    parser.add_argument("--junction", type=str, default="J1", help="Junction ID (e.g. J1, J2)")
    parser.add_argument("--approach", type=str, default="NORTHBOUND", help="Approach Direction (e.g. NORTHBOUND, SOUTHBOUND, EASTBOUND, WESTBOUND)")
    parser.add_argument("--mode", type=str, default="LIVE", help="Source Mode (LIVE or REPLAY)")
    parser.add_argument("--endpoint", type=str, default="http://localhost:3000/vision-update", help="Backend /vision-update endpoint")
    parser.add_argument("--fps", type=int, default=30, help="Max FPS processing cap")
    parser.add_argument("--conf", type=float, default=0.25, help="YOLO confidence detection threshold (default: 0.25)")
    parser.add_argument("--batch-interval", type=float, default=1.0, help="Seconds between POST requests")
    parser.add_argument("--show", action="store_true", help="Display real-time OpenCV window with AI detections overlay")
    args = parser.parse_args()

    print(f"[VISION] Loading model vision/UVH-26-MV-YOLOv11-S.pt (conf={args.conf})...", flush=True)
    model = YOLO("vision/UVH-26-MV-YOLOv11-S.pt")
    names = model.names
    
    cap = cv2.VideoCapture(int(args.source) if args.source.isdigit() else args.source)
    if not cap.isOpened():
        print(f"[VISION] ERROR: Cannot open source {args.source}", flush=True)
        return

    print(f"[VISION] Started tracking on {args.source} for {args.junction} {args.approach} ({args.mode})", flush=True)
    if args.show:
        print(f"[VISION] Real-time visual overlay enabled. Press 'Q' or 'ESC' in the video window to quit.", flush=True)
        window_name = f"AURA Vision Engine — {args.junction} {args.approach} ({args.mode})"
        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(window_name, 960, 540)

    seen_track_ids = set()
    current_batch_arrivals = {}
    last_reported_arrival_pcu = 0.0
    last_reported_arrivals_count = 0
    last_post_status = "READY"
    
    last_post_time = time.time()
    frame_time = 1.0 / max(1, args.fps)
    
    frame_count = 0
    fps_smooth = float(args.fps)

    try:
        while True:
            loop_start = time.time()
            
            ret, frame = cap.read()
            if not ret:
                print("[VISION] End of stream or error.", flush=True)
                break
                
            frame_count += 1

            # Run inference and ByteTrack with explicit confidence threshold
            results = model.track(frame, tracker="bytetrack.yaml", conf=args.conf, persist=True, verbose=False)
            
            active_tracks = 0
            scene_pcu = 0.0
            new_arrivals_this_frame = 0
            
            annotated_frame = frame.copy() if args.show else None

            if results and results[0].boxes and results[0].boxes.id is not None:
                boxes = results[0].boxes
                track_ids = boxes.id.int().cpu().tolist()
                cls_ids = boxes.cls.int().cpu().tolist()
                confs = boxes.conf.cpu().tolist()
                xyxy_coords = boxes.xyxy.int().cpu().tolist()
                
                for tid, cid, conf, (x1, y1, x2, y2) in zip(track_ids, cls_ids, confs, xyxy_coords):
                    if conf < args.conf:
                        continue

                    active_tracks += 1
                    cls_name = names.get(cid, "Others")
                    cls_weight = PCU_WEIGHTS.get(cls_name, 1.0)
                    
                    # 1. Accumulate Scene PCU from all currently active tracks in this frame
                    scene_pcu += cls_weight
                    
                    # 2. Accumulate Physical New Arrivals (each persistent track ID counts exactly once)
                    if tid not in seen_track_ids:
                        seen_track_ids.add(tid)
                        current_batch_arrivals[cls_name] = current_batch_arrivals.get(cls_name, 0) + 1
                        new_arrivals_this_frame += 1

                    # Draw bounding box and label badge if visualization is enabled
                    if args.show and annotated_frame is not None:
                        color = CLASS_COLORS.get(cls_name, (0, 255, 255))
                        cv2.rectangle(annotated_frame, (x1, y1), (x2, y2), color, 2)
                        
                        label = f"#{tid} {cls_name} {conf:.2f} ({cls_weight} PCU)"
                        (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
                        badge_y1 = max(0, y1 - th - 6)
                        badge_y2 = y1
                        cv2.rectangle(annotated_frame, (x1, badge_y1), (x1 + tw + 6, badge_y2), color, -1)
                        cv2.putText(annotated_frame, label, (x1 + 3, badge_y2 - 3), 
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)
            
            # Check if it's time to batch and POST to backend
            now = time.time()
            if now - last_post_time >= args.batch_interval:
                arrival_pcu = calculate_pcu(current_batch_arrivals)
                new_arrivals_total = sum(current_batch_arrivals.values())

                payload = {
                    "data": {
                        "junction_id": args.junction,
                        "approach_direction": args.approach,
                        "detections": current_batch_arrivals,
                        "calculated_pcu": arrival_pcu,
                        "scene_pcu": +(round(scene_pcu, 1)),
                        "tracked_count": active_tracks,
                        "source_mode": args.mode
                    }
                }
                
                try:
                    res = requests.post(args.endpoint, json=payload, timeout=2.0)
                    status = f"{res.status_code} OK" if res.status_code == 200 else f"HTTP {res.status_code}"
                except Exception as e:
                    status = f"FAIL ({type(e).__name__})"
                    
                print(f"[VISION] frame={frame_count:04d} | TRACKED={active_tracks} (SCENE PCU={scene_pcu:.1f}) | NEW ARRIVALS={new_arrivals_total} (ARRIVAL PCU={arrival_pcu:.1f}) | FPS={fps_smooth:.1f} | POST /vision-update {status}", flush=True)
                
                last_reported_arrival_pcu = arrival_pcu
                last_reported_arrivals_count = new_arrivals_total
                last_post_status = status
                
                # Reset batch arrivals accumulator
                current_batch_arrivals = {}
                last_post_time = now
                
                # Clean up seen_track_ids to prevent memory leaks in extended runs
                if len(seen_track_ids) > 10000:
                    print("[VISION] Pruning old track IDs...", flush=True)
                    seen_track_ids.clear()

            # Render HUD banner on visual output
            if args.show and annotated_frame is not None:
                h, w = annotated_frame.shape[:2]
                
                # Top telemetry banner background (68px high)
                overlay = annotated_frame.copy()
                cv2.rectangle(overlay, (0, 0), (w, 68), (13, 17, 23), -1)
                cv2.addWeighted(overlay, 0.88, annotated_frame, 0.12, 0, annotated_frame)
                
                # Bottom accent border line under banner
                cv2.line(annotated_frame, (0, 68), (w, 68), (59, 130, 246), 2)
                
                # Row 1: System Title & Assigned Corridor Context
                title_text = f"AURA AI PERCEPTION  |  ASSIGNED: {args.junction} - {args.approach}  |  FEED: {args.mode} (UVH-26 YOLOv11-S + ByteTrack)"
                cv2.putText(annotated_frame, title_text, (16, 22), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.50, (255, 255, 255), 2, cv2.LINE_AA)
                
                # Row 2: Distinct Scene PCU vs Arrival PCU Telemetry
                row2_tracked = f"TRACKED: {active_tracks}"
                row2_scene = f"SCENE PCU: {scene_pcu:.1f}"
                row2_arrivals = f"NEW ARRIVALS: {last_reported_arrivals_count} (ARRIVAL PCU: {last_reported_arrival_pcu:.1f})"
                row2_fps = f"FPS: {fps_smooth:.1f}"
                row2_backend = f"BACKEND: {last_post_status}"
                
                full_metrics_str = f"{row2_tracked}  |  {row2_scene}  |  {row2_arrivals}  |  {row2_fps}  |  {row2_backend}"
                
                backend_color = (0, 255, 128) if "200" in last_post_status or "READY" in last_post_status else (0, 80, 255)
                cv2.putText(annotated_frame, full_metrics_str, (16, 50), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.44, (200, 225, 255), 1, cv2.LINE_AA)
                
                cv2.imshow(window_name, annotated_frame)
                
                key = cv2.waitKey(1) & 0xFF
                if key == ord('q') or key == ord('Q') or key == 27: # 'q' or ESC
                    print("[VISION] Quit requested by user.", flush=True)
                    break
                    
            # Compute measured FPS and maintain processing frame rate limit
            loop_duration = time.time() - loop_start
            instant_fps = 1.0 / max(0.001, loop_duration)
            fps_smooth = 0.90 * fps_smooth + 0.10 * instant_fps
            
            if loop_duration < frame_time:
                time.sleep(frame_time - loop_duration)

    finally:
        cap.release()
        if args.show:
            cv2.destroyAllWindows()
        print("[VISION] Video capture released and session closed.", flush=True)

if __name__ == "__main__":
    run()
