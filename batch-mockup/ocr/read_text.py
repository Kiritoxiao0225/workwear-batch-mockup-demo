"""Text in each image argument, read by RapidOCR (PaddleOCR models on onnxruntime).

Prints one JSON array per image, in argument order: [{"text", "score"}]. Only confident lines are
kept; phone status bars and single characters are dropped. Tilted text is read by retrying at
small and quarter-turn rotations when the upright pass finds little.
"""
import json, re, sys
import cv2
from rapidocr import RapidOCR

MIN_SCORE, LONGEST_SIDE = 0.9, 1600
NOISE = re.compile(r'^(\d{1,2}:\d{2}.*|\d{1,2}/\d{1,2}|\d{1,3}%|[A-Za-z]{1,2}|.)$')
engine = RapidOCR(params={"EngineConfig.onnxruntime.enable_cpu_mem_arena": False})


def rotated(img, angle):
    if not angle:
        return img
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    c, s = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * s + w * c), int(h * c + w * s)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, m, (nw, nh), borderValue=(255, 255, 255))


def read(path):
    img = cv2.imread(path)
    if img is None:
        return []
    h, w = img.shape[:2]
    k = min(1.0, LONGEST_SIDE / max(h, w))
    if k < 1:
        img = cv2.resize(img, (int(w * k), int(h * k)))
    lines = {}
    for angle in (0, 10, -10, 90, -90):
        if angle and len(lines) >= 3:
            break
        result = engine(rotated(img, angle))
        for text, score in zip(result.txts or [], result.scores or []):
            text = text.strip()
            if score >= MIN_SCORE and not NOISE.match(text):
                lines[text] = max(lines.get(text, 0), round(float(score), 2))
    # A fragment read on one pass ("阳轴承") is dropped when another pass read the whole line.
    return [{"text": t, "score": s} for t, s in lines.items() if not any(t != x and t in x for x in lines)]


print(json.dumps([read(p) for p in sys.argv[1:]], ensure_ascii=False))
