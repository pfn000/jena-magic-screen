
# Jena's room, Q-WORLD v1. Run: blender -b --factory-startup -P room.py -- --task <clay-room|tex-desk|bake|...> --tex tex --out out
import bpy, bmesh, math, sys, os, json, time
from mathutils import Vector, Matrix
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(k, d=None):
    return argv[argv.index(k) + 1] if k in argv else d
TASK = arg('--task', 'clay-room'); TEX = os.path.abspath(arg('--tex', 'tex')); OUT = os.path.abspath(arg('--out', 'out'))
SAMPLES = int(arg('--samples', '128')); os.makedirs(OUT, exist_ok=True)
MODE = 'clay' if TASK.startswith('clay') else ('day' if TASK.startswith('day') or TASK.startswith('dbg-') else 'tex')
T0 = time.time()
def log(*a): print('[room %5.1fs]' % (time.time() - T0), *a, flush=True)
# ---------- scene reset ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
S = bpy.context.scene
COL = S.collection
RW, RD, RH = 5.2, 4.6, 2.9            # room interior: x width, y depth, z height
R_ROOM = 0.45                          # big soft room rounding (the "24x rounded" feel)
# ---------- helpers ----------
def apply_mods(ob):
    dg = bpy.context.evaluated_depsgraph_get(); dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data; ob.modifiers.clear(); ob.data = me
    if old.users == 0: bpy.data.meshes.remove(old)
    return ob
def smooth(ob, ang=38):
    me = ob.data
    try:
        me.shade_smooth(); me.set_sharp_from_angle(angle=math.radians(ang))
    except Exception:
        for p in me.polygons: p.use_smooth = True
def new_obj(name, me, loc=(0, 0, 0), parent=None):
    ob = bpy.data.objects.new(name, me); COL.objects.link(ob); ob.location = loc
    if parent: ob.parent = parent
    return ob
def empty(name, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None); COL.objects.link(e); e.location = loc
    if parent: e.parent = parent
    return e
def cube_mesh(name, sx, sy, sz, subdiv=0):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); return me
def bevel(ob, width, segs=8, angle=None, profile=0.5):
    m = ob.modifiers.new('bevel', 'BEVEL'); m.width = width; m.segments = segs; m.profile = profile
    m.limit_method = 'ANGLE' if angle else 'NONE'
    if angle: m.angle_limit = math.radians(angle)
    m.use_clamp_overlap = True; m.harden_normals = False
    return m
def rbox(name, size, loc, r, mat, segs=8, parent=None, sub=0):
    """rounded box: size full extents (m), r = edge radius"""
    ob = new_obj(name, cube_mesh(name, *size), loc, parent)
    bevel(ob, min(r, min(size) * 0.499), segs)
    if sub:
        s = ob.modifiers.new('sub', 'SUBSURF'); s.levels = sub; s.render_levels = sub
    apply_mods(ob); smooth(ob); setmat(ob, mat); return ob
def rcyl(name, radius, depth, loc, r, mat, verts=48, segs=6, parent=None, rot=None):
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=radius, radius2=radius, depth=depth)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = new_obj(name, me, loc, parent)
    if rot: ob.rotation_euler = rot
    m = bevel(ob, min(r, depth * 0.49, radius * 0.49), segs, angle=40)
    apply_mods(ob); smooth(ob, 50); setmat(ob, mat); return ob
def blob(name, radii, loc, mat, parent=None, squash=0.0, rot=None):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=1.0)
    for v in bm.verts:
        x, y, z = v.co
        z = z * (1 - squash * (1 - z * z)) if squash else z
        v.co = Vector((x * radii[0], y * radii[1], z * radii[2]))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = new_obj(name, me, loc, parent)
    if rot: ob.rotation_euler = rot
    smooth(ob, 80); setmat(ob, mat); return ob
def pillow(name, size, loc, mat, parent=None, rot=None, puff=0.55):
    ob = new_obj(name, cube_mesh(name, *size), loc, parent)
    if rot: ob.rotation_euler = rot
    s = ob.modifiers.new('sub', 'SUBSURF'); s.levels = 3; s.render_levels = 3
    apply_mods(ob)
    me = ob.data; hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    for v in me.vertices:
        x, y, z = v.co
        f = (1 - min(1, (x / hx) ** 2)) * (1 - min(1, (y / hy) ** 2))
        v.co.z = z * (0.45 + puff * f)                      # thin edges, puffy middle
        v.co.x *= 1 + 0.06 * (1 - (y / hy) ** 2)              # slight pinched corners
        v.co.y *= 1 + 0.06 * (1 - (x / hx) ** 2)
    smooth(ob, 80); setmat(ob, mat); return ob
def tube_path(name, pts, radius, mat, cyclic=True, parent=None):
    cu = bpy.data.curves.new(name, 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = radius; cu.bevel_resolution = 4
    cu.use_fill_caps = True
    sp = cu.splines.new('POLY'); sp.points.add(len(pts) - 1)
    for p, c in zip(sp.points, pts): p.co = (c[0], c[1], c[2], 1)
    sp.use_cyclic_u = cyclic
    tmp = bpy.data.objects.new(name + '_c', cu); COL.objects.link(tmp)
    dg = bpy.context.evaluated_depsgraph_get(); dg.update()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg)); bpy.data.objects.remove(tmp); bpy.data.curves.remove(cu)
    ob = new_obj(name, me, (0, 0, 0), parent); smooth(ob, 80); setmat(ob, mat); return ob
def rrect(cx, cy, hw, hh, r, z, n=10, plane='xy'):
    pts = []
    for (sx, sy, a0) in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        ccx, ccy = cx + sx * (hw - r), cy + sy * (hh - r)
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            u, v = ccx + r * math.cos(a), ccy + r * math.sin(a)
            pts.append((u, v, z) if plane == 'xy' else (u, z, v) if plane == 'xz' else (z, u, v))
    return pts
# ---------- UVs ----------
def box_uv(ob, tile):
    """world-scale box projection into UVMap (texture tiling = 'tile' metres per repeat)"""
    me = ob.data
    if not me.uv_layers: me.uv_layers.new(name='UVMap')
    uv = me.uv_layers[0].data
    mw = ob.matrix_world
    for p in me.polygons:
        n = (mw.to_3x3() @ p.normal); ax = max(range(3), key=lambda i: abs(n[i]))
        for li in p.loop_indices:
            co = mw @ me.vertices[me.loops[li].vertex_index].co
            if ax == 0: u, v = co.y * (1 if n.x > 0 else -1), co.z
            elif ax == 1: u, v = co.x * (-1 if n.y > 0 else 1), co.z
            else: u, v = co.x, co.y
            uv[li].uv = (u / tile, v / tile)
# ---------- materials ----------
MATS = {}
TILE = {}
def img(path, colorspace='sRGB'):
    if not os.path.exists(path): return None
    im = bpy.data.images.load(path, check_existing=True); im.colorspace_settings.name = colorspace; return im
def pbr(name, tile=1.0, rough_mul=1.0, metal=0.0, sheen=0.0, coat=0.0, spec=0.5, normal_str=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; N = nt.nodes
    b = N['Principled BSDF']; b.inputs['Metallic'].default_value = metal
    try: b.inputs['Specular IOR Level'].default_value = spec
    except Exception: pass
    if sheen:
        b.inputs['Sheen Weight'].default_value = sheen; b.inputs['Sheen Roughness'].default_value = 0.45
    if coat: b.inputs['Coat Weight'].default_value = coat; b.inputs['Coat Roughness'].default_value = 0.15
    d = os.path.join(TEX, name)
    di, ni, ri = img(os.path.join(d, 'diff.jpg')), img(os.path.join(d, 'nor.jpg'), 'Non-Color'), img(os.path.join(d, 'rough.jpg'), 'Non-Color')
    y = 300
    if di:
        t = N.new('ShaderNodeTexImage'); t.image = di; t.location = (-600, y); nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if ri:
        t = N.new('ShaderNodeTexImage'); t.image = ri; t.location = (-600, 0)
        if abs(rough_mul - 1) > 1e-3:
            mth = N.new('ShaderNodeMath'); mth.operation = 'MULTIPLY'; mth.inputs[1].default_value = rough_mul
            nt.links.new(t.outputs['Color'], mth.inputs[0]); nt.links.new(mth.outputs[0], b.inputs['Roughness'])
        else: nt.links.new(t.outputs['Color'], b.inputs['Roughness'])
    if ni:
        t = N.new('ShaderNodeTexImage'); t.image = ni; t.location = (-600, -300)
        nm = N.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = normal_str; nm.location = (-300, -300)
        nt.links.new(t.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    MATS[name] = m; TILE[name] = tile; return m
def emissive(name, color, strength, image=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.02, 0.02, 0.02, 1); b.inputs['Roughness'].default_value = 0.3
    b.inputs['Emission Color'].default_value = (*color, 1); b.inputs['Emission Strength'].default_value = strength
    if image:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(os.path.join(TEX, image))
        if t.image: nt.links.new(t.outputs['Color'], b.inputs['Emission Color'])
    MATS[name] = m; TILE[name] = 1.0; return m
def flat(name, color, rough=0.4, metal=0.0, transmission=0.0, alpha=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if transmission: b.inputs['Transmission Weight'].default_value = transmission
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha; m.blend_method = 'BLEND' if hasattr(m, 'blend_method') else None
    MATS[name] = m; TILE[name] = 1.0; return m
def setmat(ob, mat):
    if isinstance(mat, str): mat = MATS[mat]
    ob.data.materials.clear(); ob.data.materials.append(mat)
pbr('floor', tile=1.7, rough_mul=0.85)
pbr('wall', tile=1.8, normal_str=0.6)
pbr('desk', tile=0.55, coat=0.35)      # walnut veneer is a 1 m scan; 0.55 m per repeat keeps the grain desk-sized (v1 checker: stretched)
pbr('shelf', tile=1.0, coat=0.2)
pbr('bedframe', tile=0.32, sheen=0.3)
pbr('duvet', tile=0.36, sheen=0.5, normal_str=1.7)
pbr('mattress', tile=0.34, sheen=0.3, normal_str=1.5)
pbr('piping', tile=0.2, sheen=0.4)
pbr('plush', tile=0.35, sheen=1.0)
pbr('plush2', tile=0.35, sheen=1.0)
pbr('leather', tile=0.4, coat=0.15)
pbr('leather2', tile=0.4, coat=0.15)
pbr('rug', tile=0.34, sheen=0.9, normal_str=2.0)
pbr('rugedge', tile=0.25, sheen=0.5, normal_str=1.3)
pbr('ceramic', tile=0.6, rough_mul=0.3, coat=0.6)
pbr('pages', tile=0.12)
pbr('deskmat', tile=0.4)
pbr('plastic', tile=0.6, rough_mul=0.7)
pbr('plasticdk', tile=0.6, rough_mul=0.7)
pbr('curtain', tile=0.3, sheen=0.4)
def add_bump(name, scale, strength, dist=0.004):
    m = MATS.get(name)
    if not m: return
    nt = m.node_tree; N = nt.nodes; b = N['Principled BSDF']
    nz = N.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = 8.0
    tc = N.new('ShaderNodeTexCoord'); nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
    bp = N.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = strength; bp.inputs['Distance'].default_value = dist
    nt.links.new(nz.outputs['Fac'], bp.inputs['Height'])
    old = [l for l in nt.links if l.to_socket == b.inputs['Normal']]
    if old: nt.links.new(old[0].from_socket, bp.inputs['Normal'])
    nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
add_bump('rug', 260.0, 0.55, 0.006)
add_bump('duvet', 40.0, 0.18, 0.004)
add_bump('mattress', 60.0, 0.12, 0.003)
flat('metal', (0.06, 0.06, 0.07), rough=0.32, metal=1.0)
flat('chrome', (0.8, 0.8, 0.82), rough=0.12, metal=1.0)
def thin_glass(name):
    # architectural thin glass: Fresnel mix of clear Transparent + Glossy. Camera rays stay camera rays through it, so the
    # exterior photo shows as-is (v1/v2 refractive glass turned the view dark and noisy); lights stay hidden (camera vis off).
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; N = nt.nodes
    for n in list(N):
        if n.type != 'OUTPUT_MATERIAL': N.remove(n)
    out = [n for n in N if n.type == 'OUTPUT_MATERIAL'][0]
    tr = N.new('ShaderNodeBsdfTransparent'); tr.inputs['Color'].default_value = (0.97, 0.98, 1.0, 1)
    gl = N.new('ShaderNodeBsdfGlossy'); gl.inputs['Roughness'].default_value = 0.02
    fr = N.new('ShaderNodeFresnel'); fr.inputs['IOR'].default_value = 1.52
    mx = N.new('ShaderNodeMixShader'); nt.links.new(fr.outputs['Fac'], mx.inputs['Fac'])
    nt.links.new(tr.outputs['BSDF'], mx.inputs[1]); nt.links.new(gl.outputs['BSDF'], mx.inputs[2]); nt.links.new(mx.outputs['Shader'], out.inputs['Surface'])
    MATS[name] = m; TILE[name] = 1.0; return m
thin_glass('glass')
flat('lampshade', (0.95, 0.85, 0.75), rough=0.6)
NEON = {'neon_pink': (1.0, 0.18, 0.62), 'neon_cyan': (0.1, 0.78, 1.0), 'neon_violet': (0.52, 0.22, 1.0)}
for k, c in NEON.items(): emissive(k, c, 30.0)
emissive('screen1', (1, 1, 1), 2.2, 'screen1.jpg')
emissive('screen2', (1, 1, 1), 2.2, 'screen2.jpg')
emissive('sky', (1, 1, 1), 1.3)     # window exterior image is attached by make_exterior() below
emissive('lampglow', (1.0, 0.72, 0.45), 6.0)
emissive('kbglow', (0.6, 0.3, 1.0), 6.0)
# ---------- ROOM SHELL ----------
hx, hy = RW / 2, RD / 2
shell = new_obj('Room_Shell', cube_mesh('Room_Shell', RW, RD, RH), (0, 0, RH / 2))
def shell_stats(tag):
    me = shell.data; big = [(round(p.center.x, 2), round(p.center.y, 2), round(p.center.z, 2), round(p.area, 2), len(p.vertices)) for p in me.polygons if p.area > 0.8]
    log('SHELL', tag, 'polys', len(me.polygons), 'big', len(big), big[:14])
bevel(shell, R_ROOM, 14); apply_mods(shell); shell_stats('bevel')
sol = shell.modifiers.new('sol', 'SOLIDIFY'); sol.thickness = 0.18; sol.offset = 1.0; apply_mods(shell); shell_stats('solid')
# hollow solid: outer skin normals point away from the room centre, inner skin normals point INTO the room (out of the wall material).
# (recalc_face_normals here treated the inner skin as its own solid and the EXACT boolean then deleted it: v1 bug, run 38929842591)
bm = bmesh.new(); bm.from_mesh(shell.data); nflip = 0
for f in bm.faces:
    c = f.calc_center_median()
    q = Vector((max(abs(c.x) - (hx - R_ROOM), 0), max(abs(c.y) - (hy - R_ROOM), 0), max(abs(c.z) - (RH / 2 - R_ROOM), 0)))
    inner = (q.length - R_ROOM) < 0.09          # rounded-box distance: inner skin ~0, outer skin ~0.18
    d = f.normal.dot(c)
    if (inner and d > 0) or (not inner and d < 0): f.normal_flip(); nflip += 1
bm.to_mesh(shell.data); bm.free(); log('shell normals flipped', nflip)
WIN_C = (-0.85, 0.0); WIN_W, WIN_H, WIN_Z = 1.5, 1.25, 1.15
cutter = new_obj('cut', cube_mesh('cut', WIN_W, 1.0, WIN_H), (WIN_C[0], hy, WIN_Z + WIN_H / 2))
bevel(cutter, 0.16, 10); apply_mods(cutter)
b = shell.modifiers.new('win', 'BOOLEAN'); b.operation = 'DIFFERENCE'; b.object = cutter; b.solver = 'EXACT'
apply_mods(shell); bpy.data.objects.remove(cutter); shell_stats('bool')
bv = bevel(shell, 0.035, 4, angle=30); apply_mods(shell); shell_stats('bevel2')
bm = bmesh.new(); bm.from_mesh(shell.data)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
kill = []
for f in bm.faces:
    c = f.calc_center_median()
    if abs(c.x) > hx + 0.12 or abs(c.y) > hy + 0.12 or abs(c.z) > RH / 2 + 0.12: kill.append(f)
bmesh.ops.delete(bm, geom=kill, context='FACES')
bm.to_mesh(shell.data); bm.free()
shell.location = (0, 0, RH / 2); smooth(shell, 30); shell_stats('final')
shell.data.materials.append(MATS['wall']); shell.data.materials.append(MATS['floor'])
for p in shell.data.polygons:
    c = p.center
    p.material_index = 1 if (p.normal.z > 0.92 and c.z < -RH / 2 + 0.05) else 0
TILE_OVERRIDE = {'Room_Shell': 1.8}
# ---------- WINDOW ----------
win = empty('Window', (WIN_C[0], hy, WIN_Z + WIN_H / 2))
fr = new_obj('Window_Frame', cube_mesh('wf', WIN_W - 0.02, 0.09, WIN_H - 0.02), (0, 0.02, 0), win)
inner = new_obj('wfi', cube_mesh('wfi', WIN_W - 0.16, 0.5, WIN_H - 0.16), (WIN_C[0], hy + 0.02, WIN_Z + WIN_H / 2))
bevel(inner, 0.1, 8); apply_mods(inner)
bevel(fr, 0.15, 10); apply_mods(fr)
b = fr.modifiers.new('b', 'BOOLEAN'); b.operation = 'DIFFERENCE'; b.object = inner; b.solver = 'EXACT'; apply_mods(fr); bpy.data.objects.remove(inner)
bevel(fr, 0.012, 3, angle=30); apply_mods(fr); smooth(fr, 30); setmat(fr, 'plastic')
mul = rbox('Window_Mullion', (0.05, 0.06, WIN_H - 0.16), (0, 0.02, 0), 0.02, 'plastic', 4, win)
gl = rbox('Window_Glass', (WIN_W - 0.16, 0.012, WIN_H - 0.16), (0, 0.02, 0), 0.005, 'glass', 2, win)
sill = rbox('Window_Sill', (WIN_W + 0.2, 0.28, 0.05), (0, -0.12, -WIN_H / 2 - 0.02), 0.02, 'shelf', 5, win)
# exterior backdrop: a big plane 3 m outside the window carrying a photo of trees + sky rendered from a CC0 HDRI (make_exterior).
# v1 checker: the window read as a blank/blown white panel (the fill area lights were visible through the glass) -> lights are now
# invisible to transmission rays and the plane is exposure-controlled per look; it never lights the room (diffuse/glossy/shadow off).
EXT_W, EXT_H, EXT_D, EXT_Z = 9.0, 5.6, 3.0, 1.6
bm = bmesh.new()
vs = [bm.verts.new(p) for p in ((-EXT_W / 2, 0, -EXT_H / 2), (EXT_W / 2, 0, -EXT_H / 2), (EXT_W / 2, 0, EXT_H / 2), (-EXT_W / 2, 0, EXT_H / 2))]
f = bm.faces.new(vs); uvl = bm.loops.layers.uv.new('UVMap')
for l, uv in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))): l[uvl].uv = uv
me = bpy.data.meshes.new('sky'); bm.to_mesh(me); bm.free()
skyp = new_obj('Sky_Backdrop', me, (WIN_C[0], hy + EXT_D, EXT_Z)); setmat(skyp, 'sky'); skyp['keep_uv'] = 1
for a in ('visible_diffuse', 'visible_glossy', 'visible_shadow', 'visible_volume_scatter'):
    try: setattr(skyp, a, False)
    except Exception: pass
def make_exterior():
    """Render the HDRI as a flat photo for the backdrop (day) and a dark blue night version. Returns (day_img, night_img) or None."""
    import numpy as np
    hp = os.path.join(TEX, 'ext.hdr')
    if not os.path.exists(hp): log('no ext.hdr; window keeps the plain sky'); return None
    keep = bpy.context.window.scene if bpy.context.window else S
    sc = bpy.data.scenes.new('ExtScene'); w = bpy.data.worlds.new('ExtWorld'); sc.world = w; w.use_nodes = True
    et = w.node_tree.nodes.new('ShaderNodeTexEnvironment'); et.image = bpy.data.images.load(hp)
    w.node_tree.links.new(et.outputs['Color'], w.node_tree.nodes['Background'].inputs['Color'])
    cd = bpy.data.cameras.new('ExtCam'); cd.sensor_fit = 'HORIZONTAL'; cd.sensor_width = 36
    cd.lens = 18 / math.tan(math.atan(EXT_W / 2 / EXT_D))
    co = bpy.data.objects.new('ExtCam', cd); sc.collection.objects.link(co); sc.camera = co
    yaw = math.radians(float(arg('--ext-yaw', '0')))
    co.rotation_euler = (math.radians(90), 0, yaw - math.radians(90))      # look along +X (the HDRI's centre) rotated by yaw
    sc.render.engine = 'CYCLES'; sc.cycles.samples = 4; sc.cycles.use_denoising = False; sc.cycles.device = 'CPU'
    RX = 2048; RY = int(RX * EXT_H / EXT_W)
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = RX, RY, 100
    sc.render.image_settings.file_format = 'OPEN_EXR'; sc.render.image_settings.color_depth = '32'
    p = os.path.join(OUT, '_ext.exr'); sc.render.filepath = p
    bpy.ops.render.render(write_still=True, scene=sc.name)
    im = bpy.data.images.load(p); px = np.empty(RX * RY * 4, np.float32); im.pixels.foreach_get(px); px = px.reshape(RY, RX, 4)[..., :3]
    bpy.data.images.remove(im); os.remove(p)
    lum = (px * [0.2126, 0.7152, 0.0722]).sum(-1)
    day = px * (0.72 / max(float(np.percentile(lum, 90)), 1e-4))
    day = day / (1 + np.maximum(day - 0.8, 0))                           # soft shoulder: no clipped white blocks
    lumd = (day * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    night = lumd * np.array([0.30, 0.42, 1.0]) * 0.075                   # dark navy sky, near-black tree line
    rng = np.random.default_rng(11); ys = rng.integers(int(RY * 0.55), RY, 260); xs = rng.integers(0, RX, 260)   # blender pixel rows run bottom-up: stars in the upper part
    sky_mask = lumd[ys, xs, 0] > 0.45
    night[ys[sky_mask], xs[sky_mask]] = rng.uniform(0.12, 0.35, (int(sky_mask.sum()), 1))     # a few stars, only where there is sky
    out = []
    for nm, a in (('exterior_day', day), ('exterior_night', night)):
        a = np.clip(a, 0, 1); srgb = np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)
        img_ = bpy.data.images.new(nm, RX, RY, alpha=False)
        rgba = np.concatenate([srgb, np.ones((RY, RX, 1), np.float32)], -1).astype(np.float32)
        img_.pixels.foreach_set(rgba.ravel()); img_.filepath_raw = os.path.join(OUT, nm + '.jpg'); img_.file_format = 'JPEG'; img_.save()
        bpy.data.images.remove(img_)
        img_ = bpy.data.images.load(os.path.join(OUT, nm + '.jpg'), check_existing=False); img_.name = nm; out.append(img_)
        log('exterior', nm, 'p50 %.3f p99 %.3f' % (float(np.median(a)), float(np.percentile(a, 99))))
    bpy.data.scenes.remove(sc)
    return out
EXT = make_exterior()
if EXT:
    nt = MATS['sky'].node_tree; t = nt.nodes.new('ShaderNodeTexImage'); t.name = 'EXT_IMG'; t.image = EXT[0]
    nt.links.new(t.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Emission Color'])
# curtains: wavy fabric panels at both sides
def curtain(name, x):
    bm = bmesh.new(); nx, nz = 40, 30; w, h = 0.55, 1.5
    verts = [[bm.verts.new((-w / 2 + w * i / nx, 0.04 * math.sin(i / nx * math.pi * 6), h * j / nz)) for j in range(nz + 1)] for i in range(nx + 1)]
    for i in range(nx):
        for j in range(nz): bm.faces.new((verts[i][j], verts[i + 1][j], verts[i + 1][j + 1], verts[i][j + 1]))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = new_obj(name, me, (x, hy - 0.16, 1.0))
    s = ob.modifiers.new('s', 'SOLIDIFY'); s.thickness = 0.012
    apply_mods(ob); smooth(ob, 80); setmat(ob, 'curtain'); return ob
curtain('Curtain_L', WIN_C[0] - WIN_W / 2 - 0.22); curtain('Curtain_R', WIN_C[0] + WIN_W / 2 + 0.22)
rcyl('Curtain_Rod', 0.016, WIN_W + 1.3, (WIN_C[0], hy - 0.16, 2.52), 0.008, 'metal', rot=(0, math.pi / 2, 0))
# ---------- BED (head against the back wall, left side) ----------
bed = empty('Bed', (-hx + 0.1 + 0.7, hy - 0.08 - 1.05, 0))
BW, BL = 1.4, 2.1
rbox('Bed_Frame', (BW + 0.1, BL + 0.08, 0.32), (0, 0, 0.22), 0.12, 'bedframe', 8, bed)
rbox('Bed_Headboard', (BW + 0.14, 0.16, 0.95), (0, BL / 2 - 0.02, 0.55), 0.07, 'bedframe', 8, bed)
for i in range(4):   # padded channel tufts
    rbox('Bed_HeadPad_%d' % i, (BW / 4 - 0.04, 0.08, 0.62), (-BW / 2 + BW / 8 + i * BW / 4, BL / 2 - 0.11, 0.70), 0.035, 'bedframe', 6, bed)
rbox('Bed_Mattress', (BW, BL - 0.06, 0.24), (0, -0.02, 0.5), 0.09, 'mattress', 8, bed)
for zz in (0.5 + 0.12 - 0.012, 0.5 - 0.12 + 0.012):          # piped seams around the mattress top/bottom edge
    tube_path('Bed_MattressPiping', rrect(0, -0.02, BW / 2 - 0.004, (BL - 0.06) / 2 - 0.004, 0.09, zz, 8), 0.009, 'piping', parent=bed)
def quilt(name, size, loc, r, mat, parent, cell=0.3, depth=0.03, cuts=56):
    # dense grid box -> rounded corners (angle-limited bevel) -> puffy quilted squares on top -> soft wrinkles
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = new_obj(name, me, loc, parent)
    bevel(ob, r, 6, angle=30); apply_mods(ob)
    hx_, hy_, hz_ = size[0] / 2, size[1] / 2, size[2] / 2
    for v in ob.data.vertices:
        x, y, z = v.co
        if z < hz_ - 0.004: continue
        edge = min(1.0, (hx_ - abs(x)) / 0.12, (hy_ - abs(y)) / 0.12)
        if edge <= 0: continue
        pf = (abs(math.sin(math.pi * x / cell)) * abs(math.sin(math.pi * y / cell))) ** 0.4
        v.co.z = z + depth * pf * edge - depth * 0.35 * edge
    d = ob.modifiers.new('d', 'DISPLACE'); tx = bpy.data.textures.new(name + '_wr', 'CLOUDS'); tx.noise_scale = 0.22; d.texture = tx; d.strength = 0.02
    apply_mods(ob); smooth(ob, 80); setmat(ob, mat); return ob
du = quilt('Bed_Duvet', (BW + 0.12, BL * 0.72, 0.1), (0, -BL * 0.15, 0.66), 0.05, 'duvet', bed, cell=0.34, depth=0.05)
rbox('Bed_DuvetFold', (BW + 0.13, 0.22, 0.12), (0, BL * 0.21, 0.69), 0.055, 'duvet', 6, bed, sub=1)
pillow('Bed_Pillow_L', (0.6, 0.4, 0.22), (-0.33, BL / 2 - 0.32, 0.72), 'plush', bed, rot=(math.radians(-12), 0, 0))
pillow('Bed_Pillow_R', (0.6, 0.4, 0.22), (0.33, BL / 2 - 0.32, 0.72), 'plush2', bed, rot=(math.radians(-12), 0, 0))
pillow('Bed_Cushion', (0.38, 0.38, 0.16), (0.05, BL / 2 - 0.62, 0.74), 'leather2', bed, rot=(math.radians(-30), 0, math.radians(15)))
# plush bear (cute, rounded blobs)
bear = empty('Plush_Bear', (0.45, -0.05, 0.72), bed)
blob('Bear_Body', (0.13, 0.11, 0.15), (0, 0, 0.13), 'plush', bear)
blob('Bear_Head', (0.11, 0.1, 0.1), (0, 0, 0.36), 'plush', bear)
for s in (-1, 1):
    blob('Bear_Ear_%d' % s, (0.04, 0.025, 0.04), (s * 0.08, 0, 0.45), 'plush', bear)
    blob('Bear_Arm_%d' % s, (0.04, 0.04, 0.08), (s * 0.13, -0.02, 0.16), 'plush', bear, rot=(0, s * 0.5, 0))
    blob('Bear_Leg_%d' % s, (0.05, 0.07, 0.045), (s * 0.07, -0.08, 0.03), 'plush', bear)
blob('Bear_Snout', (0.045, 0.035, 0.035), (0, -0.09, 0.34), 'plush2', bear)
bear.rotation_euler = (0, 0, math.radians(-20))
# under-bed neon
tube_path('Neon_UnderBed', rrect(0, 0, BW / 2 + 0.02, BL / 2 - 0.05, 0.12, 0.07, 6), 0.01, 'neon_violet', parent=bed)
# nightstand + lamp (front side of the bed)
ns = empty('Nightstand', (-hx + 0.38, hy - 0.08 - BL - 0.38, 0))
rbox('Nightstand_Body', (0.5, 0.42, 0.52), (0, 0, 0.27), 0.08, 'shelf', 8, ns)
rbox('Nightstand_Drawer', (0.42, 0.02, 0.18), (0, -0.21, 0.33), 0.03, 'plastic', 5, ns)
rcyl('Lamp_Base', 0.09, 0.05, (0.05, 0.02, 0.555), 0.02, 'plasticdk', parent=ns)
rcyl('Lamp_Stem', 0.012, 0.28, (0.05, 0.02, 0.72), 0.005, 'chrome', parent=ns)
blob('Lamp_Bulb', (0.11, 0.11, 0.09), (0.05, 0.02, 0.9), 'lampglow', ns)
# ---------- DESK (right of the window, against the back wall) ----------
desk = empty('Desk', (1.35, hy - 0.45, 0))
DW, DD, DH = 1.8, 0.78, 0.76
rbox('Desk_Top', (DW, DD, 0.045), (0, 0, DH), 0.022, 'desk', 6, desk)
for sx in (-1, 1):
    rbox('Desk_Leg_%d' % sx, (0.07, DD - 0.12, 0.05), (sx * (DW / 2 - 0.12), 0, 0.03), 0.024, 'metal', 6, desk)
    rbox('Desk_Post_%d' % sx, (0.06, 0.06, DH - 0.06), (sx * (DW / 2 - 0.12), 0.05, DH / 2), 0.026, 'metal', 6, desk)
rbox('Desk_Beam', (DW - 0.3, 0.05, 0.08), (0, 0.18, DH - 0.08), 0.02, 'metal', 5, desk)
rbox('Desk_Mat', (1.05, 0.42, 0.006), (0, -0.12, DH + 0.026), 0.003, 'deskmat', 3, desk)
def monitor(name, x, ang, scr):
    m = empty(name, (x, 0.2, DH), desk); m.rotation_euler = (0, 0, ang)
    rbox(name + '_Bezel', (0.64, 0.035, 0.38), (0, 0, 0.42), 0.02, 'plasticdk', 6, m)
    rbox(name + '_Screen', (0.61, 0.006, 0.35), (0, -0.019, 0.42), 0.012, scr, 3, m)
    rbox(name + '_Neck', (0.06, 0.03, 0.26), (0, 0.04, 0.2), 0.012, 'plasticdk', 4, m)
    rbox(name + '_Foot', (0.24, 0.17, 0.016), (0, 0.02, 0.03), 0.008, 'plasticdk', 4, m)
    return m
monitor('Monitor_L', -0.34, math.radians(14), 'screen1')
monitor('Monitor_R', 0.34, math.radians(-14), 'screen2')
# fix screen UVs to show the whole image (planar 0..1 over the face)
for nm in ('Monitor_L_Screen', 'Monitor_R_Screen'):
    ob = bpy.data.objects[nm]; me = ob.data; me.uv_layers.new(name='UVMap'); uv = me.uv_layers[0].data
    xs = [v.co.x for v in me.vertices]; zs = [v.co.z for v in me.vertices]
    for li, l in enumerate(me.loops):
        co = me.vertices[l.vertex_index].co
        uv[li].uv = ((co.x - min(xs)) / (max(xs) - min(xs)), (co.z - min(zs)) / (max(zs) - min(zs)))
    ob['keep_uv'] = 1
kb = rbox('Keyboard', (0.44, 0.14, 0.022), (-0.05, -0.15, DH + 0.04), 0.008, 'plasticdk', 4, desk)
rbox('Keyboard_Glow', (0.44, 0.145, 0.004), (-0.05, -0.15, DH + 0.03), 0.002, 'kbglow', 2, desk)
def keycaps(name, loc, parent):
    # one mesh, 5 rows of individual rounded keys (+ spacebar) instead of 4 flat strips
    bm = bmesh.new(); P = 0.0272
    rows = [[1] * 15, [1.5] + [1] * 12 + [1.5], [1.75] + [1] * 11 + [2.25], [2.25] + [1] * 10 + [2.75], [1.25] * 3 + [6.25] + [1.25] * 4]
    for ri, row in enumerate(rows):
        x = -0.5 * P * sum(row)
        for wk in row:
            g = bmesh.ops.create_cube(bm, size=1.0)['verts']
            sx, sy, sz = wk * P - 0.004, P - 0.004, 0.011
            for v in g: v.co = Vector((v.co.x * sx + x + wk * P / 2, v.co.y * sy + (2 - ri) * P, v.co.z * sz))
            x += wk * P
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = new_obj(name, me, loc, parent); bevel(ob, 0.0025, 2, angle=30); apply_mods(ob); smooth(ob, 30); setmat(ob, 'plastic'); return ob
keycaps('Keycaps', (-0.05, -0.15, DH + 0.056), desk)
blob('Mouse', (0.032, 0.055, 0.02), (0.32, -0.15, DH + 0.04), 'plasticdk', desk, squash=0.3)
hp = empty('Headphones', (-0.74, -0.08, DH + 0.022), desk); hp.rotation_euler = (0, 0, math.radians(25))
for s in (-1, 1):
    rcyl('Headphones_Cup_%d' % s, 0.048, 0.034, (s * 0.085, 0, 0.017), 0.012, 'leather', parent=hp)
    rcyl('Headphones_Pad_%d' % s, 0.044, 0.016, (s * 0.085, 0, 0.042), 0.007, 'leather2', parent=hp)
tube_path('Headphones_Band', [(0.085 * math.cos(a), 0.13 * math.sin(a), 0.03) for a in [math.pi * k / 24 for k in range(25)]], 0.011, 'leather', cyclic=False, parent=hp)
rcyl('Mug', 0.041, 0.095, (0.62, -0.2, DH + 0.0705), 0.006, 'ceramic', parent=desk)
rcyl('Mug_Cocoa', 0.035, 0.002, (0.62, -0.2, DH + 0.1185), 0.0008, 'leather', parent=desk)
tube_path('Mug_Handle', [(0.62 + 0.041 + 0.028 * math.sin(a), -0.2, DH + 0.07 + 0.03 * math.cos(a)) for a in [math.pi * k / 16 for k in range(17)]], 0.007, 'ceramic', cyclic=False, parent=desk)
tube_path('Neon_Desk', [(u, hy - 0.035, v) for (u, v, _) in rrect(1.35, 1.15, 0.95, 0.32, 0.2, 0, 8)], 0.01, 'neon_cyan')
# ---------- GAMING CHAIR ----------
CH = empty('Chair', (1.35, hy - 1.25, 0))
CH.rotation_euler = (0, 0, math.radians(-8))
for i in range(5):
    a = math.radians(90 + i * 72)
    leg = rbox('Chair_BaseLeg_%d' % i, (0.06, 0.32, 0.045), (math.cos(a) * 0.16, math.sin(a) * 0.16, 0.09), 0.02, 'plasticdk', 5, CH)
    leg.rotation_euler = (0, 0, a - math.pi / 2)
    blob('Chair_Caster_%d' % i, (0.03, 0.03, 0.03), (math.cos(a) * 0.31, math.sin(a) * 0.31, 0.035), 'plasticdk', CH)
rcyl('Chair_Gas', 0.025, 0.3, (0, 0, 0.26), 0.008, 'chrome', parent=CH)
seat = empty('Chair_Swivel', (0, 0, 0.42), CH)            # rig: everything above the base swivels around this pivot
seat.rotation_euler = (0, 0, math.radians(-14))
rbox('Chair_Seat', (0.54, 0.52, 0.12), (0, 0, 0.08), 0.055, 'leather', 8, seat, sub=1)
rbox('Chair_SeatInsert', (0.3, 0.44, 0.03), (0, 0, 0.145), 0.014, 'leather2', 5, seat, sub=1)
bk = rbox('Chair_Back', (0.52, 0.12, 0.82), (0, -0.27, 0.58), 0.055, 'leather', 8, seat, sub=1)
bk.rotation_euler = (math.radians(10), 0, 0)
bi = rbox('Chair_BackInsert', (0.28, 0.03, 0.62), (0, -0.212, 0.55), 0.014, 'leather2', 5, seat, sub=1)
bi.rotation_euler = (math.radians(10), 0, 0)
for s in (-1, 1):
    w = rbox('Chair_Wing_%d' % s, (0.08, 0.13, 0.55), (s * 0.24, -0.25, 0.5), 0.04, 'leather', 6, seat)
    w.rotation_euler = (math.radians(10), 0, s * math.radians(8))
    rbox('Chair_ArmPost_%d' % s, (0.05, 0.05, 0.2), (s * 0.31, 0.0, 0.17), 0.02, 'plasticdk', 4, seat)
    rbox('Chair_ArmPad_%d' % s, (0.09, 0.26, 0.04), (s * 0.31, 0.02, 0.28), 0.02, 'leather', 5, seat)
pillow('Chair_HeadPillow', (0.3, 0.2, 0.11), (0, -0.23, 0.95), 'plush', seat, rot=(math.radians(100), 0, 0), puff=0.9)
pillow('Chair_LumbarPillow', (0.34, 0.2, 0.11), (0, -0.13, 0.33), 'plush2', seat, rot=(math.radians(100), 0, 0), puff=0.9)
# ---------- SHELVES (right wall) + desk shelf ----------
def shelf(name, loc, length, axis='y'):
    s = empty(name, loc)
    size = (0.24, length, 0.04) if axis == 'y' else (length, 0.24, 0.04)
    rbox(name + '_Board', size, (0, 0, 0), 0.018, 'shelf', 6, s)
    return s
s1 = shelf('Shelf_A', (hx - 0.13, 0.55, 1.55), 1.2)
s2 = shelf('Shelf_B', (hx - 0.13, 0.75, 1.95), 0.9)
s3 = shelf('Shelf_Desk', (1.35, hy - 0.13, 1.62), 1.3, axis='x')
import random; random.seed(3)
cols = ['plush', 'plush2', 'leather2', 'bedframe', 'plastic']
for si, (sh, n, ax) in enumerate(((s2, 4, 'y'), (s3, 6, 'x'))):     # shelf A gets a scanned CC0 book set (below)
    for i in range(n):
        h = random.uniform(0.16, 0.24); t = random.uniform(0.03, 0.05)
        off = -0.45 + i * 0.075 if n > 4 else -0.3 + i * 0.075
        size = (0.17, t, h) if ax == 'y' else (t, 0.17, h)
        loc = (0, off, 0.02 + h / 2) if ax == 'y' else (off, 0, 0.02 + h / 2)
        rbox('%s_Book_%d' % (sh.name, i), size, loc, 0.008, random.choice(cols), 3, sh)
        for bz in (0.02 + h * 0.18, 0.02 + h * 0.82):      # printed spine bands so they read as books, not blocks
            bsz = (0.004, t * 1.02, 0.012) if ax == 'y' else (t * 1.02, 0.004, 0.012)
            bl = (-0.086, off, bz) if ax == 'y' else (off, -0.086, bz)
            rbox('%s_Band_%d_%d' % (sh.name, i, int(bz * 1000)), bsz, bl, 0.0015, 'pages', 2, sh)
SHELF_PLANTS = [((hx - 0.13, 0.55 + 0.4, 1.57), 0.3), ((1.35 + 0.45, hy - 0.13, 1.64), 0.26)]   # placed after the model loader is defined
blob('Shelf_A_Orb', (0.06, 0.06, 0.06), (0, -0.62, 0.08), 'neon_pink', s1)
# ---------- RUG + BEANBAG ----------
def rug(name, R, loc, h=0.03, rings=44, segs=176):
    # polar grid so the pile can be shaped: a soft domed top, rolled-off edge and low lumpy pile (v1 checker: 'a flat disc')
    from mathutils import noise
    bm = bmesh.new(); cen = bm.verts.new((0, 0, h)); prev = None; rings_v = []
    for i in range(1, rings + 1):
        r = R * i / rings; ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs; x, y = r * math.cos(a), r * math.sin(a)
            t = r / R; z = h * (1 - max(0.0, (t - 0.9) / 0.1) ** 2) if t > 0.9 else h
            z += 0.004 * noise.noise(Vector((x * 9, y * 9, 0.3))) + 0.0025 * noise.noise(Vector((x * 31, y * 31, 1.7)))
            z += 0.009 * math.exp(-((r - 0.80 * R) / 0.035) ** 2) + 0.006 * math.exp(-((r - 0.52 * R) / 0.03) ** 2)   # carved/tufted rings
            z -= 0.005 * math.exp(-((r - 0.66 * R) / 0.06) ** 2)
            ring.append(bm.verts.new((x, y, max(z, 0.002))))
        rings_v.append(ring)
    for j in range(segs): bm.faces.new((cen, rings_v[0][j], rings_v[0][(j + 1) % segs]))
    for i in range(rings - 1):
        a_, b_ = rings_v[i], rings_v[i + 1]
        for j in range(segs): bm.faces.new((a_[j], b_[j], b_[(j + 1) % segs], a_[(j + 1) % segs]))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = new_obj(name, me, loc); smooth(ob, 80); setmat(ob, 'rug')
    ring_pts = [(loc[0] + (R + 0.012) * math.cos(2 * math.pi * k / 128), loc[1] + (R + 0.012) * math.sin(2 * math.pi * k / 128), 0.018) for k in range(128)]
    tube_path(name + '_Edge', ring_pts, 0.02, 'rugedge')      # rolled, bound edge in a darker corduroy
    return ob
rug('Rug', 1.02, (0.15, -0.35, 0.0))
bb = blob('Beanbag', (0.5, 0.5, 0.32), (-1.45, -1.75, 0.3), 'plush2', squash=0.25)
blob('Beanbag_Cushion', (0.3, 0.12, 0.2), (-1.55, -1.55, 0.6), 'plush', rot=(math.radians(70), 0, math.radians(-20)))
# ---------- CEILING NEON (concentric with the room's rounded corners) ----------
tube_path('Neon_Ceiling', rrect(0, 0, hx - 0.17, hy - 0.17, R_ROOM - 0.17, RH - 0.17, 10), 0.012, 'neon_pink')
# ---------- READY-MADE CC0 MODELS (Poly Haven glTF, fetched on the runner) ----------
def place_model(mid, loc, rotz=0.0, height=None, width=None):
    d = os.path.join(TEX, 'models', mid)
    fs = [x for x in (os.listdir(d) if os.path.isdir(d) else []) if x.endswith('.gltf') or x.endswith('.glb')]
    if not fs: log('model missing', mid); return None
    before = set(bpy.data.objects)
    try: bpy.ops.import_scene.gltf(filepath=os.path.join(d, fs[0]))
    except Exception as e: log('import failed', mid, e); return None
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.name not in COL.objects:
            for c in list(o.users_collection): c.objects.unlink(o)
            COL.objects.link(o)
    root = empty('Asset_' + mid)
    for o in new:
        if o.parent is None: o.parent = root
    bpy.context.view_layer.update()
    ms = [o for o in new if o.type == 'MESH']
    pts = [o.matrix_world @ Vector(c) for o in ms for c in o.bound_box]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    sc = 1.0
    if height: sc = height / max(mx.z - mn.z, 1e-4)
    elif width: sc = width / max(mx.x - mn.x, 1e-4)
    ctr = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    for o in new:
        if o.parent is root: o.location = o.location - ctr
    root.scale = (sc, sc, sc); root.rotation_euler = (0, 0, math.radians(rotz)); root.location = loc
    for o in ms:
        o['keep_uv'] = 1
        if o.data.uv_layers and o.data.uv_layers[0].name != 'UVMap': o.data.uv_layers[0].name = 'UVMap'
    log('model', mid, 'meshes', len(ms), 'scale %.3f' % sc, 'size', tuple(round((mx[i] - mn[i]) * sc, 2) for i in range(3)))
    return root
DESK_Y = hy - 0.45
for nm in ('Bed_Pillow_L', 'Bed_Pillow_R', 'Bed_Cushion'):
    if nm in bpy.data.objects: bpy.data.objects.remove(bpy.data.objects[nm])
place_model('throw_pillows_01', (-hx + 0.8, hy - 0.08 - 1.05 + BL / 2 - 0.42, 0.61), 0, width=1.25)
place_model('desk_lamp_arm_01', (1.35 + 0.74, DESK_Y + 0.14, DH + 0.022), 200, height=0.62)
place_model('potted_plant_04', (WIN_C[0] + 0.5, hy - 0.14, WIN_Z + 0.006), 0, height=0.3)
place_model('wooden_display_shelves_01', (-hx + 0.24, -1.15, 0), 90, height=1.3)   # left wall: out of the wide shot's right foreground (v1 checker)
place_model('alarm_clock_01', (-hx + 0.24, hy - 0.08 - BL - 0.46, 0.53), 90, height=0.13)
place_model('rubber_duck_toy', (1.35 - 0.62, DESK_Y + 0.12, DH + 0.022), -25, height=0.11)
for loc_, hgt in SHELF_PLANTS: place_model('potted_plant_02', loc_, 30, height=hgt)
place_model('book_encyclopedia_set_01', (hx - 0.13, 0.33, 1.572), -90, width=None, height=0.235)
# ---------- UV pass ----------
bpy.context.view_layer.update()
for ob in list(COL.objects):
    if ob.type != 'MESH' or ob.get('keep_uv'): continue
    names = [m.name for m in ob.data.materials]
    tile = TILE_OVERRIDE.get(ob.name, TILE.get(names[0], 1.0) if names else 1.0)
    box_uv(ob, tile)
log('built', len([o for o in COL.objects if o.type == 'MESH']), 'meshes, polys', sum(len(o.data.polygons) for o in COL.objects if o.type == 'MESH'))
# glass/backdrop must not block light
for nm in ('Window_Glass', 'Sky_Backdrop', 'Lamp_Bulb'):
    bpy.data.objects[nm].visible_shadow = False
# ---------- cameras ----------
CAMS = {
 'wide':  ((2.2, -2.0, 1.95), (-0.7, 1.0, 0.75), 17),
 'window': ((1.0, -0.9, 1.3), (-0.85, hy, 1.62), 21),
 'desk':  ((0.2, 0.45, 1.5), (1.55, 2.15, 0.98), 22),
 'bed':   ((0.45, -0.65, 1.55), (-1.9, 1.25, 0.6), 22),
 'chair': ((1.33, hy - 1.27, 1.22), (1.35, hy + 0.2, 1.08), 20),
}
def make_cam(k):
    pos, tgt, lens = CAMS[k]
    c = bpy.data.cameras.new('Cam_' + k); c.lens = lens; c.sensor_width = 36; c.clip_start = 0.05
    o = bpy.data.objects.new('Cam_' + k, c); COL.objects.link(o); o.location = pos
    o.rotation_euler = (Vector(tgt) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler(); return o
for k in CAMS: make_cam(k)
cams_json = {}
for k, (pos, tgt, lens) in CAMS.items():
    vfov = 2 * math.degrees(math.atan((36 * 9 / 16) / 2 / lens))
    cams_json[k] = {'position': [pos[0], pos[2], -pos[1]], 'target': [tgt[0], tgt[2], -tgt[1]], 'fov': round(vfov, 2)}   # three.js Y-up
json.dump(cams_json, open(os.path.join(OUT, 'cameras.json'), 'w'), indent=1)
# ---------- lights / world / render ----------
def light(name, kind, loc, energy, color, rot_to=None, size=None, size_y=None, angle=None):
    ld = bpy.data.lights.new(name, kind); ld.energy = energy; ld.color = color
    if kind == 'AREA':
        ld.shape = 'RECTANGLE'; ld.size = size; ld.size_y = size_y or size
    if kind == 'SUN' and angle: ld.angle = math.radians(angle)
    if kind == 'POINT' and size: ld.shadow_soft_size = size
    o = bpy.data.objects.new(name, ld); COL.objects.link(o); o.location = loc
    if kind == 'AREA': o.visible_camera = False; o.visible_glossy = False   # fill panels behind the window must not show as a white slab
    try: o.visible_transmission = False      # ...and not through the window glass either (v1: blown white window, night-bed 4.8% near-white)
    except Exception: pass
    if rot_to: o.rotation_euler = (Vector(rot_to) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return o
W = bpy.data.worlds.new('World'); S.world = W; W.use_nodes = True
bg = W.node_tree.nodes['Background']
S.render.engine = 'CYCLES'; S.cycles.device = 'CPU'; S.cycles.samples = SAMPLES
S.cycles.use_denoising = True
try: S.cycles.denoiser = 'OPENIMAGEDENOISE'
except Exception: pass
S.cycles.max_bounces = 8; S.cycles.diffuse_bounces = 5; S.cycles.glossy_bounces = 4; S.cycles.transmission_bounces = 6
S.cycles.sample_clamp_indirect = 8.0; S.cycles.caustics_reflective = False; S.cycles.caustics_refractive = False
S.render.resolution_x, S.render.resolution_y, S.render.resolution_percentage = 1600, 900, 100
S.render.image_settings.file_format = 'JPEG'; S.render.image_settings.quality = 92
S.view_settings.view_transform = 'AgX'
WIN_OUT = (WIN_C[0], hy + 0.55, WIN_Z + WIN_H / 2)
def setup_look(MODE):
    for o in [o for o in COL.objects if o.type == 'LIGHT']: bpy.data.objects.remove(o)
    for n in [n for n in W.node_tree.nodes if n.type == 'TEX_ENVIRONMENT']: W.node_tree.nodes.remove(n)
    bpy.data.objects['Sky_Backdrop'].hide_render = False
    for k in NEON: MATS[k].node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 30.0
    skyb = MATS['sky'].node_tree.nodes['Principled BSDF']; skyt = MATS['sky'].node_tree.nodes.get('EXT_IMG')
    if skyt and EXT: skyt.image = EXT[0] if MODE == 'day' else EXT[1]
    skyb.inputs['Emission Strength'].default_value = float(arg('--sky-day', '1.25')) if MODE == 'day' else float(arg('--sky', '1.6'))
    log('window exterior', skyt.image.name if skyt and skyt.image else None, 'strength', skyb.inputs['Emission Strength'].default_value)
    try: S.view_settings.look = 'None'
    except Exception: pass
    if MODE == 'clay':
        bg.inputs['Color'].default_value = (0.75, 0.8, 0.9, 1); bg.inputs['Strength'].default_value = 0.9
        bpy.data.objects['Sky_Backdrop'].hide_render = True; bpy.data.objects['Window_Glass'].hide_render = True
        sun = light('Sun', 'SUN', (0, 0, 5), 4.0, (1.0, 0.95, 0.88), angle=3); sun.rotation_euler = Vector((0.35, -0.75, -0.55)).to_track_quat('-Z', 'Y').to_euler()
        light('WindowFill', 'AREA', WIN_OUT, 260, (0.9, 0.95, 1.0), rot_to=(WIN_C[0], 0, 0.8), size=1.6, size_y=1.4)
        light('CeilingFill', 'AREA', (0.2, -0.3, RH - 0.05), 160, (1, 1, 1), rot_to=(0.2, -0.3, 0), size=2.2, size_y=1.8)
        clay = bpy.data.materials.new('Clay'); clay.use_nodes = True
        cb = clay.node_tree.nodes['Principled BSDF']; cb.inputs['Base Color'].default_value = (0.72, 0.72, 0.74, 1); cb.inputs['Roughness'].default_value = 0.65
        S.view_layers[0].material_override = clay
        S.view_settings.exposure = -0.55
    elif MODE == 'day':
        bg.inputs['Color'].default_value = (0.55, 0.68, 0.9, 1); bg.inputs['Strength'].default_value = 0.6
        hp = os.path.join(TEX, 'day.hdr')
        if os.path.exists(hp):
            et = W.node_tree.nodes.new('ShaderNodeTexEnvironment'); et.image = bpy.data.images.load(hp)
            W.node_tree.links.new(et.outputs['Color'], bg.inputs['Color']); bg.inputs['Strength'].default_value = 1.0
        sun = light('Sun', 'SUN', (0, 0, 5), 5.5, (1.0, 0.93, 0.82), angle=2.5); sun.rotation_euler = Vector((0.35, -0.75, -0.55)).to_track_quat('-Z', 'Y').to_euler()
        light('WindowSky', 'AREA', WIN_OUT, 420, (0.85, 0.92, 1.0), rot_to=(WIN_C[0], 0, 0.8), size=1.5, size_y=1.3)
        light('CeilingBounce', 'AREA', (0.4, -0.6, RH - 0.05), 70, (1.0, 0.96, 0.9), rot_to=(0.4, -0.6, 0), size=2.4, size_y=2.0)
        for k in NEON: MATS[k].node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 4.0
        S.view_settings.exposure = float(arg('--exp-day', '-0.3'))
    else:
        bg.inputs['Color'].default_value = (0.012, 0.012, 0.03, 1); bg.inputs['Strength'].default_value = 1.0
        NEON_NIGHT = float(arg('--neon', '7'))      # 30 flooded the closed room pink (run 38932037999); dark room + bright tubes
        for k in NEON: MATS[k].node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = NEON_NIGHT
        light('MoonFill', 'AREA', WIN_OUT, 70, (0.55, 0.66, 1.0), rot_to=(WIN_C[0], 0, 0.6), size=1.6, size_y=1.4)
        moon = light('Moon', 'SUN', (0, 0, 5), 0.9, (0.62, 0.72, 1.0), angle=1.5); moon.rotation_euler = Vector((0.25, -0.8, -0.55)).to_track_quat('-Z', 'Y').to_euler()
        light('LampWarm', 'POINT', (-hx + 0.43, hy - 0.08 - 2.1 - 0.36, 0.9), 12, (1.0, 0.72, 0.45), size=0.08)
        S.view_settings.exposure = float(arg('--exp', '-0.3'))
        try: S.view_settings.look = 'AgX - Punchy'
        except Exception:
            try: S.view_settings.look = 'Punchy'
            except Exception: pass
    log("look", MODE)
setup_look(MODE)
def bloom():
    S.use_nodes = True; nt = S.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    rl = nt.nodes.new('CompositorNodeRLayers'); g = nt.nodes.new('CompositorNodeGlare'); co = nt.nodes.new('CompositorNodeComposite')
    try: g.glare_type = 'BLOOM'
    except Exception: g.glare_type = 'FOG_GLOW'
    g.quality = 'HIGH'; g.threshold = 1.6; g.mix = -0.6
    try: g.size = 8
    except Exception: pass
    nt.links.new(rl.outputs['Image'], g.inputs['Image']); nt.links.new(g.outputs['Image'], co.inputs['Image'])
    log('bloom', g.glare_type)
def render_cam(k, fname):
    S.camera = bpy.data.objects['Cam_' + k]; S.render.filepath = os.path.join(OUT, fname)
    t = time.time(); bpy.ops.render.render(write_still=True); log('rendered', fname, '%.0fs' % (time.time() - t))
# ---------- tasks ----------
if TASK.startswith('clay-'):
    render_cam(TASK[5:], 'clay-%s.jpg' % TASK[5:])
elif TASK.startswith('tex-'):
    bloom(); render_cam(TASK[4:], 'night-%s.jpg' % TASK[4:])
elif TASK.startswith('day-'):
    render_cam(TASK[4:], 'day-%s.jpg' % TASK[4:])
elif TASK.startswith('dbgn-'):
    bloom(); S.render.resolution_percentage = 30; S.cycles.samples = 12; render_cam(TASK[5:], 'dbgn-%s.jpg' % TASK[5:])
elif TASK.startswith('dbg-'):
    S.render.resolution_percentage = 30; S.cycles.samples = 12; render_cam(TASK[4:], 'dbg-%s.jpg' % TASK[4:])
elif TASK == 'save':
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'room.blend'))
elif TASK == 'bake' or TASK.startswith('glb'):
    exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bake.py')).read())
log('done', TASK)
# rev 1792167013506882093
# rev 1792167247686092703
# rev 1792167595800061185
# rev 1792167696153258079
# rev 1792169751759545031
# rev 1792170004920772539
# rev 1792170039339204352
# rev 1792172343544369268
