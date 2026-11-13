"""生成 docs/og.png（1200×630 社交卡片）——README 顶部横幅 / Pages og:image 共用。

视觉与 docs/index.html 一致：深色底 + 品牌蓝 #6c8cff + 线框柱状图标。
本脚本是 docs/og.png 的唯一来源——改品牌文案请只改下面的常量，不要手改 PNG。

用法：python scripts/make-og.py
依赖：Pillow（`pip install pillow`）；字体默认取 Windows 自带，非 Windows 会自动降级。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- 品牌常量
TITLE = "持仓看板"
TITLE_EN = "dsh-portfolio"
SUBTITLE_HEAD = "A 股实时行情 + 场外基金看板 · 装进 "
SUBTITLE_TAIL = "DeepSeek Harness"
SUBTITLE_END = " 的面板"
REPO = "github.com/HPNY/dsh-portfolio"
EYEBROW = ["DEEPSEEK HARNESS PLUGIN", "OPEN SOURCE MIT", "A-SHARE & FUND DASHBOARD"]
CHIPS = [
    ("实时行情", "plain"),
    ("分时 / K 线", "plain"),
    ("自选股盈亏", "plain"),
    ("价格预警", "plain"),
    ("四种选股模式", "plain"),
    ("涨停情绪", "up"),
    ("龙虎榜", "plain"),
    ("7×24 快讯", "plain"),
    ("AI 个股分析", "plain"),
    ("基金净值 / 解套", "down"),
]
# 面板缩略里的页签（与 src/client/panel.js 的 TABS 前五项一致，仅作示意）
MOCK_TABS = ["大盘", "行情", "自选", "选股", "基金"]
MOCK_ACTIVE = 0
MOCK_ROWS = [("上证指数", "+1.24%", True), ("深证成指", "+0.87%", True), ("创业板指", "-0.32%", False)]
FOOT_NOTE = ["公开免费数据源 · 无需 API key · 只监听 127.0.0.1", "数据仅供研究，不构成投资建议"]

# ---------------------------------------------------------------- 配色
BG = (10, 12, 18)  # #0a0c12
BRAND = (108, 140, 255)  # #6c8cff
BRAND_LIGHT = (143, 168, 255)  # #8fa8ff
UP = (240, 66, 77)  # #f0424d
DOWN = (16, 185, 129)  # #10b981
TEXT = (232, 236, 244)  # #e8ecf4
TEXT_DIM = (185, 196, 218)  # #b9c4da
TEXT_MUTED = (143, 160, 196)  # #8fa0c4
TEXT_FAINT = (123, 136, 166)  # #7b88a6

W, H = 1200, 630
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "og.png"

# 字体：优先 Windows，其次是 macOS / Linux 常见路径；都找不到就用 PIL 内置位图字体。
FONT_DIRS = [
    Path("C:/Windows/Fonts"),
    Path("/System/Library/Fonts"),
    Path("/usr/share/fonts/truetype/noto"),
]
BOLD_NAMES = ["msyhbd.ttc", "PingFang.ttc", "NotoSansCJK-Bold.ttc", "DejaVuSans-Bold.ttf"]
REG_NAMES = ["msyh.ttc", "PingFang.ttc", "NotoSansCJK-Regular.ttc", "DejaVuSans.ttf"]
SANS_NAMES = ["segoeui.ttf", "Helvetica.ttc", "DejaVuSans.ttf"]


def find_font(names):
    for directory in FONT_DIRS:
        for name in names:
            candidate = directory / name
            if candidate.exists():
                return candidate
    return None


BOLD_PATH = find_font(BOLD_NAMES)
REG_PATH = find_font(REG_NAMES)
SANS_PATH = find_font(SANS_NAMES)


def font(path, size):
    """按需缓存字体对象；缺字体时退化为 PIL 默认字体（不中断生成）。"""
    if path is None:
        return ImageFont.load_default()
    key = (str(path), size)
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = ImageFont.truetype(str(path), size)
    return _FONT_CACHE[key]


_FONT_CACHE = {}


def text_width(draw, text, fnt, tracking=0.0):
    if not text:
        return 0.0
    width = draw.textlength(text, font=fnt)
    return width + tracking * (len(text) - 1)


def draw_tracked(draw, xy, text, fnt, fill, tracking):
    """逐字绘制以模拟 CSS 的 letter-spacing。"""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill, anchor="lt")
        x += draw.textlength(ch, font=fnt) + tracking


def lerp(start, end, t):
    return int(round(start + (end - start) * t))


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(size[1]):
        t = y / max(size[1] - 1, 1)
        color = (lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t))
        for x in range(size[0]):
            px[x, y] = color
    return img


def smoothstep(edge0, edge1, value):
    """标准 smoothstep，两端导数为 0，避免出现可见的色带边界。"""
    if edge1 <= edge0:
        return 0.0 if value < edge0 else 1.0
    t = (value - edge0) / (edge1 - edge0)
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return t * t * (3.0 - 2.0 * t)


def add_radial_glow(img, center, radius, color, strength, squash=1.0):
    """解析式计算径向高光并叠加到图上。

    这里刻意不用「画椭圆 + GaussianBlur」的做法：8 位灰度遮罩做高斯模糊会产生
    等值带（banding），在纯深色底上会显成一道道楔形斜线。直接按距离算平滑权重
    没有量化中间态，色阶过渡连续。
    """
    cx, cy = center
    px = img.load()
    for y in range(H):
        dy = (y - cy) / squash
        for x in range(W):
            dx = x - cx
            dist = (dx * dx + dy * dy) ** 0.5
            weight = (1.0 - smoothstep(0.0, radius, dist)) * strength
            if weight <= 0.0:
                continue
            weight = min(weight, 1.0)
            r, g, b = px[x, y]
            px[x, y] = (
                lerp(r, color[0], weight),
                lerp(g, color[1], weight),
                lerp(b, color[2], weight),
            )


def grid_fade(x, y):
    """40px 网格的径向渐隐：对齐 docs/index.html 的
    `radial-gradient(820px 460px at 30% 20%, #000 0%, transparent 78%)`。

    CSS 的 820px/460px 是径向尺寸的一半，78% 处完全透明，故有效半径是
    820*0.78 与 460*0.78。归一化后按线性衰减，两端仍用 smoothstep 收口。
    """
    cx, cy = 0.30 * W, 0.20 * H
    rx, ry = 820 * 0.78, 460 * 0.78
    dist = (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) ** 0.5
    if dist >= 1.0:
        return 0.0
    return 1.0 - dist


def round_rect(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


# ---------------------------------------------------------------- 背景
img = vertical_gradient((W, H), BG, BG)

# 左上偏冷高光 + 右下微亮，呼应 docs/index.html 的两层 radial-gradient
add_radial_glow(img, center=(0.18 * W, -0.12 * H), radius=900, color=(27, 39, 69), strength=1.0, squash=0.53)
add_radial_glow(img, center=(1.0 * W, 1.08 * H), radius=760, color=(20, 36, 58), strength=0.72, squash=0.55)

# 40px 细网格，用径向渐隐在中部淡出（同样按解析权重逐像素混合）
base_px = img.load()
GRID_ALPHA = 0.055  # 对齐 CSS 里的 rgba(108,140,255,.055)
for y in range(H):
    for x in range(W):
        if x % 40 and y % 40:
            continue
        line_weight = GRID_ALPHA * grid_fade(x, y)
        if line_weight <= 0.0:
            continue
        r, g, b = base_px[x, y]
        base_px[x, y] = (
            lerp(r, BRAND[0], line_weight),
            lerp(g, BRAND[1], line_weight),
            lerp(b, BRAND[2], line_weight),
        )

# 不加有序抖动：实测在 1200×630 的深色渐变上，Bayer 抖动会把台阶换成横向噪点纹理，
# 观感反而更差，体积也从 108kb 涨到 154kb。台阶本身只有二十几级、正常观看不可见，
# 真正的修复是上面用解析式径向渐变替代「高斯模糊遮罩」（后者才会产生楔形色带）。
d = ImageDraw.Draw(img)

# ---------------------------------------------------------------- 布局
PAD_L, PAD_R, PAD_T, PAD_B = 68, 68, 54, 46
content_w = W - PAD_L - PAD_R  # 1064

# 1) eyebrow
eyebrow_font = font(SANS_PATH, 15)
eyebrow_tracking = 2.4  # 0.16em
eyebrow_h = 24
eyebrow_y = PAD_T
x = PAD_L
for index, segment in enumerate(EYEBROW):
    draw_tracked(d, (x, eyebrow_y + 3), segment, eyebrow_font, TEXT_MUTED, eyebrow_tracking)
    x += text_width(d, segment, eyebrow_font, eyebrow_tracking)
    if index < len(EYEBROW) - 1:
        x += 14
        d.ellipse([x, eyebrow_y + 11, x + 4, eyebrow_y + 15], fill=(74, 90, 126))
        x += 4 + 14

# 2) 图标 + 主标题
head_top = eyebrow_y + eyebrow_h + 22
mark_size = 92
mark_box = [PAD_L, head_top, PAD_L + mark_size, head_top + mark_size]
mark_layer = vertical_gradient((mark_size, mark_size), (32, 46, 92), (20, 30, 60))
mark_mask = Image.new("L", (mark_size, mark_size), 0)
ImageDraw.Draw(mark_mask).rounded_rectangle([0, 0, mark_size - 1, mark_size - 1], radius=22, fill=255)
img.paste(mark_layer, (mark_box[0], mark_box[1]), mark_mask)
round_rect(d, mark_box, 22, outline=(75, 100, 190), width=2)

# 线框柱状图（与 assets/icon.svg 同一套路径，viewBox 24 → 52px）
icon = 52
icon_off_x = mark_box[0] + (mark_size - icon) // 2
icon_off_y = mark_box[1] + (mark_size - icon) // 2
scale = icon / 24
# 与 SVG 的 stroke-width:1.9 等价——按 viewBox 缩放换算成像素宽度
stroke = max(1, int(round(1.9 * scale)))


def ip(x, y):
    return (icon_off_x + x * scale, icon_off_y + y * scale)


d.line([ip(3, 3), ip(3, 21)], fill=BRAND_LIGHT, width=stroke)
d.line([ip(3, 21), ip(21, 21)], fill=BRAND_LIGHT, width=stroke)
for bx, by0, by1 in [(18, 9, 17), (13, 5, 17), (8, 14, 17)]:
    d.line([ip(bx, by0), ip(bx, by1)], fill=BRAND_LIGHT, width=stroke)

# 标题块
titles_x = PAD_L + mark_size + 26
title_font = font(BOLD_PATH, 68)
title_en_font = font(BOLD_PATH, 34)
sub_font = font(REG_PATH, 25)
sub_bold_font = font(BOLD_PATH, 25)

title_h = 72
d.text((titles_x, head_top), TITLE, font=title_font, fill=TEXT, anchor="lt")
title_w = d.textlength(TITLE, font=title_font)
d.text((titles_x + title_w + 14, head_top + 26), TITLE_EN, font=title_en_font, fill=(127, 142, 179), anchor="lt")

sub_y = head_top + title_h + 8
cursor = titles_x
for chunk, fnt, color in [
    (SUBTITLE_HEAD, sub_font, TEXT_DIM),
    (SUBTITLE_TAIL, sub_bold_font, TEXT),
    (SUBTITLE_END, sub_font, TEXT_DIM),
]:
    d.text((cursor, sub_y), chunk, font=fnt, fill=color, anchor="lt")
    cursor += d.textlength(chunk, font=fnt)

head_bottom = max(head_top + mark_size, sub_y + 40)

# 3) 功能胶囊
chip_font = font(REG_PATH, 17)
chip_h, chip_gap, chip_pad = 38, 10, 15
CHIP_STYLES = {
    "plain": ((20, 26, 42), (66, 84, 145), (207, 216, 234)),
    "up": ((37, 20, 28), (128, 44, 52), (240, 126, 134)),
    "down": ((14, 33, 27), (22, 105, 76), (99, 230, 190)),
}
chips_y = head_bottom + 20
x, y = PAD_L, chips_y
for text, style in CHIPS:
    tw = d.textlength(text, font=chip_font)
    chip_w = int(tw + chip_pad * 2)
    if x + chip_w > W - PAD_R:
        x, y = PAD_L, y + chip_h + chip_gap
    fill_c, outline_c, text_c = CHIP_STYLES[style]
    round_rect(d, [x, y, x + chip_w, y + chip_h], chip_h // 2, fill=fill_c, outline=outline_c, width=1)
    d.text((x + chip_pad, y + chip_h / 2), text, font=chip_font, fill=text_c, anchor="lm")
    x += chip_w + chip_gap
chips_bottom = y + chip_h

# 4) 面板缩略（页签条 + 指数行 + 面积走势）
foot_line_h = 48
foot_top = H - PAD_B - foot_line_h - 18
mock_top = chips_bottom + 18
mock_bottom = foot_top - 16
mock_h = mock_bottom - mock_top
mock_box = [PAD_L, mock_top, W - PAD_R, mock_bottom]

mock_bg = vertical_gradient((int(mock_box[2] - mock_box[0]), int(mock_h)), (19, 24, 34), (12, 16, 24))
mock_mask = Image.new("L", mock_bg.size, 0)
ImageDraw.Draw(mock_mask).rounded_rectangle([0, 0, mock_bg.size[0] - 1, mock_bg.size[1] - 1], radius=14, fill=255)
img.paste(mock_bg, (mock_box[0], mock_top), mock_mask)
round_rect(d, mock_box, 14, outline=(43, 56, 90), width=1)

side_w = 128
d.line([mock_box[0] + side_w, mock_top + 1, mock_box[0] + side_w, mock_bottom - 1], fill=(38, 50, 82), width=1)
tab_font = font(REG_PATH, 12)
tab_y = mock_top + 11
for index, label in enumerate(MOCK_TABS):
    row = [mock_box[0] + 10, tab_y, mock_box[0] + side_w - 10, tab_y + 24]
    if index == MOCK_ACTIVE:
        round_rect(d, row, 6, fill=(26, 34, 58))
    dot_color = BRAND_LIGHT if index == MOCK_ACTIVE else TEXT_MUTED
    d.ellipse([row[0] + 8, tab_y + 9, row[0] + 14, tab_y + 15], fill=dot_color)
    d.text((row[0] + 22, tab_y + 12), label, font=tab_font, fill=(207, 216, 234) if index == MOCK_ACTIVE else (147, 161, 189), anchor="lm")
    tab_y += 27

main_x0 = mock_box[0] + side_w + 16
main_x1 = mock_box[2] - 16
row_font = font(REG_PATH, 13)
pill_font = font(REG_PATH, 12)
row_y = mock_top + 12
cursor = main_x0
for name, pct, is_up in MOCK_ROWS:
    d.text((cursor, row_y), name, font=row_font, fill=TEXT_MUTED, anchor="lt")
    cursor += d.textlength(name, font=row_font) + 10
    pill_w = int(d.textlength(pct, font=pill_font) + 18)
    pill_color = UP if is_up else DOWN
    round_rect(d, [cursor, row_y - 2, cursor + pill_w, row_y + 18], 10, fill=(38, 22, 30) if is_up else (16, 38, 32), outline=pill_color, width=1)
    d.text((cursor + pill_w / 2, row_y + 8), pct, font=pill_font, fill=pill_color, anchor="mm")
    cursor += pill_w + 18

chart_top = row_y + 26
chart_bottom = mock_bottom - 12
chart_w = main_x1 - main_x0
chart_h = chart_bottom - chart_top
# 与 docs/index.html 内联 SVG 同一条折线（viewBox 760×96）
points_raw = [
    (0, 74), (40, 68), (80, 72), (120, 58), (160, 62), (200, 50), (240, 55), (280, 44), (320, 49),
    (360, 36), (400, 42), (440, 30), (480, 34), (520, 24), (560, 29), (600, 18), (640, 23), (680, 14),
    (720, 19), (760, 10),
]
points = [(main_x0 + px / 760 * chart_w, chart_top + py / 96 * chart_h) for px, py in points_raw]

fill_mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(fill_mask).polygon(points + [(points[-1][0], chart_bottom), (points[0][0], chart_bottom)], fill=255)
area = Image.new("RGB", (W, H), (0, 0, 0))
area_px = area.load()
for yy in range(int(chart_top), int(chart_bottom) + 1):
    t = (yy - chart_top) / max(chart_h, 1)
    color = (lerp(BRAND[0], 0, t * 0.85), lerp(BRAND[1], 0, t * 0.85), lerp(BRAND[2], 0, t * 0.85))
    for xx in range(int(main_x0), int(main_x1) + 1):
        area_px[xx, yy] = color
img = Image.composite(area, img, fill_mask.point(lambda v: int(v * 0.34)))
d = ImageDraw.Draw(img)

for index in range(len(points) - 1):
    d.line([points[index], points[index + 1]], fill=BRAND_LIGHT, width=2)
d.ellipse([points[-1][0] - 4, points[-1][1] - 4, points[-1][0] + 4, points[-1][1] + 4], fill=BRAND_LIGHT)

# 5) 页脚
d.line([PAD_L, foot_top, W - PAD_R, foot_top], fill=(44, 56, 90), width=1)
repo_font = font(BOLD_PATH, 22)
d.text((PAD_L, foot_top + 18), REPO, font=repo_font, fill=BRAND_LIGHT, anchor="lt")

note_font = font(REG_PATH, 15)
note_y = foot_top + 18
for line in FOOT_NOTE:
    d.text((W - PAD_R, note_y), line, font=note_font, fill=TEXT_FAINT, anchor="rt")
    note_y += 24

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, optimize=True)
print(f"{OUT}  {OUT.stat().st_size // 1024}kb  {img.size[0]}x{img.size[1]}")
