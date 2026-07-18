#!/usr/bin/env python3
"""Rasterize the Branchline mark into a 1024×1024 source icon."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri" / "icons" / "app-icon-source.png"
FAVICON_PNG = ROOT / "public" / "brand" / "branchline-mark-512.png"
SIZE = 1024


def mix(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
    )


def main() -> None:
    scale = 3
    canvas = SIZE * scale

    def sx(v: float) -> float:
        return v / 32 * canvas

    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))

    bg_tl = (16, 24, 38)
    bg_br = (8, 14, 22)
    radius = int(sx(8))

    grad = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    for y in range(canvas):
        t = y / max(canvas - 1, 1)
        color = mix(bg_tl, bg_br, t * 0.9)
        gdraw.line([(0, y), (canvas, y)], fill=(*color, 255))

    mask = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=radius, fill=255)
    plate = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    plate.paste(grad, (0, 0), mask)
    img.alpha_composite(plate)

    # Subtle cyan rim
    rim = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    rdraw = ImageDraw.Draw(rim)
    rim_w = max(int(sx(0.85)), 2)
    inset = rim_w // 2
    rdraw.rounded_rectangle(
        (inset, inset, canvas - 1 - inset, canvas - 1 - inset),
        radius=max(radius - inset, 1),
        outline=(62, 207, 255, 70),
        width=rim_w,
    )
    img.alpha_composite(rim)

    cyan = (62, 207, 255)
    cyan_hi = (154, 232, 255)
    stroke_w = max(int(sx(2.45)), 6)

    graph = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    gd = ImageDraw.Draw(graph)

    x0, y0 = sx(11.5), sx(7.5)
    fork_y = sx(14.5)
    x1, y1 = sx(21.0), sx(17.5)
    y2 = sx(24.5)

    # Smooth elbow via many segments
    elbow = []
    steps = 24
    for i in range(steps + 1):
        t = i / steps
        # ease from vertical drop into horizontal
        yy = fork_y + (y1 - fork_y) * (t * t)
        xx = x0 + (x1 - x0) * (t * t * (3 - 2 * t))
        elbow.append((xx, yy))

    def fat_line(points: list[tuple[float, float]], color: tuple[int, int, int], width: int) -> None:
        gd.line(points, fill=(*color, 255), width=width, joint="curve")
        r = width / 2
        for cx, cy in (points[0], points[-1]):
            gd.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(*color, 255))

    fat_line([(x0, y0), (x0, fork_y)], cyan_hi, stroke_w)
    fat_line(elbow, cyan, stroke_w)
    fat_line([(x0, fork_y), (x0, y2)], cyan, stroke_w)

    # Soft glow behind graph
    glow = graph.filter(ImageFilter.GaussianBlur(radius=sx(0.55)))
    glow = Image.blend(
        Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0)),
        glow,
        0.35,
    )
    img.alpha_composite(glow)
    img.alpha_composite(graph)

    nodes = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    nd = ImageDraw.Draw(nodes)
    node_r = sx(2.4)
    for i, (cx, cy) in enumerate([(x0, y0), (x1, y1), (x0, y2)]):
        color = mix((200, 244, 255), (62, 207, 255), i / 2)
        nd.ellipse((cx - node_r, cy - node_r, cx + node_r, cy + node_r), fill=(*color, 255))
        hr = node_r * 0.42
        nd.ellipse(
            (cx - hr, cy - node_r * 0.55, cx + hr * 0.55, cy - node_r * 0.08),
            fill=(255, 255, 255, 90),
        )
    img.alpha_composite(nodes)

    final = img.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    final.save(OUT, "PNG")
    print(f"wrote {OUT}")

    mid = final.resize((512, 512), Image.Resampling.LANCZOS)
    FAVICON_PNG.parent.mkdir(parents=True, exist_ok=True)
    mid.save(FAVICON_PNG, "PNG")
    print(f"wrote {FAVICON_PNG}")


if __name__ == "__main__":
    main()
