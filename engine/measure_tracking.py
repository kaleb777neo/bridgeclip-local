"""Empirical check: how well the rendered framing follows the speaker.

Samples each clip at ~6 fps, detects faces with the engine's own YuNet model,
and reports centre error, drift, jitter and dropouts per clip.
"""
import sys
from pathlib import Path

import cv2
import numpy as np

MODEL = str(Path(__file__).parent / "assets" / "models" / "face_detection_yunet_2023mar.onnx")
SAMPLE_STEP = 5  # every 5th frame ~ 6 fps at 30fps


def analyse(clip):
    cap = cv2.VideoCapture(clip)
    det = cv2.FaceDetectorYN_create(MODEL, "", (320, 568), 0.6, 0.3, 5)
    det.setTopK(5)
    offsets, sizes, gaps = [], [], []
    prev = None
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        idx += 1
        if idx % SAMPLE_STEP:
            continue
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (320, 568))
        det.setInputSize((320, 568))
        _, faces = det.detect(small)
        if faces is None or len(faces) == 0:
            offsets.append(None)
            continue
        # dominant face = largest
        face = max(faces, key=lambda f: f[2] * f[3])
        cx, cy = (face[0] + face[2] / 2) / 320.0, (face[1] + face[3] / 2) / 568.0
        offsets.append((cx - 0.5, cy - 0.5))
        sizes.append(face[2] * face[3] / (320 * 568))
        if prev is not None:
            gaps.append(abs(cx - prev[0]) + abs(cy - prev[1]))
        prev = (cx, cy)
    cap.release()
    present = [o for o in offsets if o is not None]
    if not present:
        return None
    err = [abs(o[0]) for o in present]
    err_y = [abs(o[1]) for o in present]
    dropout = max((len(list(g())) for k, g in __import__('itertools').groupby(offsets) if k is None), default=0)
    out = {
        "frames": idx,
        "face %": round(100 * len(present) / max(1, len(offsets)), 1),
        "dx mean": round(100 * float(np.mean(err)), 1),
        "dx p95": round(100 * float(np.percentile(err, 95)), 1),
        "dx max": round(100 * float(np.max(err)), 1),
        "dy mean": round(100 * float(np.mean(err_y)), 1),
        "jitter p95": round(100 * float(np.percentile(gaps, 95)), 2) if gaps else None,
        "longest dropout s": round(dropout * SAMPLE_STEP / 30.0, 1),
    }
    return out


for clip in sys.argv[1:]:
    r = analyse(clip)
    print(Path(clip).parent.name + "/" + Path(clip).name, "->", r)
