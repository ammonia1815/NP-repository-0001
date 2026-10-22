# -*- coding: utf-8 -*-
"""Improved HSV chroma key: catches lower-saturation transition pixels at the
edge (which the first version under-detected), applies despill globally based
on green excess rather than only within the pre-computed edge band, and
erodes the alpha mask by ~1px to trim the thinnest contaminated boundary row.
"""
import sys
import cv2
import numpy as np
from PIL import Image

TARGET_HUE = 120


def key_frame(bgr_path: str, out_path: str):
    img = cv2.imread(bgr_path, cv2.IMREAD_COLOR)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    h, s, v = hsv[:, :, 0] * 2, hsv[:, :, 1] / 255.0, hsv[:, :, 2] / 255.0

    hue_dist = np.minimum(np.abs(h - TARGET_HUE), 360 - np.abs(h - TARGET_HUE))
    # Wider hue tolerance and a gentler saturation requirement so partially
    # desaturated transition pixels (blended bg+foreground) are still caught.
    hue_score = np.clip(1 - hue_dist / 50, 0, 1)
    sat_score = np.clip(s / 0.25, 0, 1)  # any noticeable saturation counts, not just >0.35
    greenness = hue_score * sat_score

    alpha = np.clip(1 - greenness * 1.6, 0, 1)

    # Erode the alpha mask by ~1px: a pixel only stays opaque if it AND its
    # neighbors are opaque, trimming the thinnest contaminated boundary row.
    alpha_u8 = (alpha * 255).astype(np.uint8)
    kernel = np.ones((3, 3), np.uint8)
    alpha_eroded = cv2.erode(alpha_u8, kernel, iterations=1).astype(np.float32) / 255.0
    # Blend eroded with original so we don't over-shrink fine hair wisps too harshly.
    alpha_final = np.minimum(alpha, alpha_eroded * 1.15)
    alpha_final = np.clip(alpha_final, 0, 1)

    b, g, r = img[:, :, 0].astype(np.float32), img[:, :, 1].astype(np.float32), img[:, :, 2].astype(np.float32)
    # Despill only in a thin band right next to where the background got cut
    # away (contamination lives right at that seam) - not anywhere a pixel
    # merely "looks greenish", which would also mute real green/cyan effects
    # sitting well inside the opaque area.
    background_like = (alpha < 0.5).astype(np.uint8) * 255
    near_seam = cv2.dilate(background_like, np.ones((7, 7), np.uint8), iterations=1) > 0
    cap = (r + b) / 2
    g_desp = np.where(near_seam & (g > cap), cap, g)

    out_rgb = np.stack([r, g_desp, b], axis=-1)
    out = np.dstack([out_rgb, alpha_final * 255]).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(out_path)


if __name__ == "__main__":
    key_frame(sys.argv[1], sys.argv[2])
