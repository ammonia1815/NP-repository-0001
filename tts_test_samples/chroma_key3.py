# -*- coding: utf-8 -*-
"""HSV chroma key v3: fixes v2's over-erosion, which blindly shrank the whole
silhouette by ~1px (eating cheeks/waist/legs/thin hair strands) because it
eroded the alpha mask spatially regardless of whether a pixel actually
measured as "green". This version does NOT touch neighboring pixels at all -
alpha depends only on that pixel's own greenness score, run through a sharp
smoothstep so partially-green edge pixels collapse to fully transparent
quickly (killing the thin residual green line) while pixels with near-zero
greenness (skin/hair/effects, confirmed by direct HSV sampling to score ~0
even right at the silhouette edge) stay fully opaque.
"""
import sys
import cv2
import numpy as np
from PIL import Image

TARGET_HUE = 120
LOW = 0.10   # greenness below this -> fully opaque
HIGH = 0.30  # greenness above this -> fully transparent


def key_frame(bgr_path: str, out_path: str):
    img = cv2.imread(bgr_path, cv2.IMREAD_COLOR)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    h, s, v = hsv[:, :, 0] * 2, hsv[:, :, 1] / 255.0, hsv[:, :, 2] / 255.0

    hue_dist = np.minimum(np.abs(h - TARGET_HUE), 360 - np.abs(h - TARGET_HUE))
    hue_score = np.clip(1 - hue_dist / 50, 0, 1)
    sat_score = np.clip(s / 0.25, 0, 1)
    greenness = hue_score * sat_score

    # Sharp smoothstep collapse: no spatial erosion, purely per-pixel color
    # decision, so it never nibbles at foreground pixels that score near-zero.
    t = np.clip((greenness - LOW) / (HIGH - LOW), 0, 1)
    smooth = t * t * (3 - 2 * t)
    alpha = 1 - smooth

    b, g, r = img[:, :, 0].astype(np.float32), img[:, :, 1].astype(np.float32), img[:, :, 2].astype(np.float32)
    background_like = (alpha < 0.5).astype(np.uint8) * 255
    near_seam = cv2.dilate(background_like, np.ones((7, 7), np.uint8), iterations=1) > 0
    cap = (r + b) / 2
    g_desp = np.where(near_seam & (g > cap), cap, g)

    out_rgb = np.stack([r, g_desp, b], axis=-1)
    out = np.dstack([out_rgb, alpha * 255]).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(out_path)


if __name__ == "__main__":
    key_frame(sys.argv[1], sys.argv[2])
