
# exec'd inside room.py (task "bake"): lightmap UVs, Cycles bake, panorama env, GLB export.
import numpy as np
SKIP_BAKE = TASK.startswith('glb'); LM = int(arg('--lm', '2048')); BS = int(arg('--bake-samples', '40'))
S.cycles.max_bounces = 6; S.cycles.diffuse_bounces = 4; S.cycles.glossy_bounces = 2; S.cycles.transmission_bounces = 4
NOBAKE_MATS = {'neon_pink', 'neon_cyan', 'neon_violet', 'screen1', 'screen2', 'sky', 'lampglow', 'kbglow', 'glass'}
bpy.context.view_layer.update()
meshes = [o for o in COL.objects if o.type == 'MESH']
bakeobs = [o for o in meshes if not ({m.name for m in o.data.materials} & NOBAKE_MATS)]
log('bake objects', len(bakeobs), 'of', len(meshes))
for o in bakeobs:
    me = o.data
    if 'lightmap' not in me.uv_layers: me.uv_layers.new(name='lightmap')
    me.uv_layers['UVMap'].active_render = True
    me.uv_layers.active = me.uv_layers['lightmap']
for o in COL.objects: o.select_set(False)
for o in bakeobs: o.select_set(True)
bpy.context.view_layer.objects.active = bakeobs[0]
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, scale_to_bounds=False)
bpy.ops.uv.select_all(action='SELECT')
bpy.ops.uv.average_islands_scale()
try: bpy.ops.uv.pack_islands(rotate=True, margin=0.003)
except TypeError: bpy.ops.uv.pack_islands(margin=0.003)
bpy.ops.object.mode_set(mode='OBJECT')
log('lightmap uvs packed')
lm = bpy.data.images.new('lightmap', LM, LM, alpha=False, float_buffer=True)
mats = {m for o in bakeobs for m in o.data.materials}
bnodes = []
for m in mats:
    nt = m.node_tree; n = nt.nodes.new('ShaderNodeTexImage'); n.image = lm; n.location = (-900, 600)
    uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'lightmap'; nt.links.new(uvn.outputs['UV'], n.inputs['Vector'])
    for x in nt.nodes: x.select = False
    n.select = True; nt.nodes.active = n; bnodes.append((m, n, uvn))
S.cycles.samples = BS
S.render.bake.margin = 16
try: S.render.bake.margin_type = 'EXTEND'
except Exception: pass
for look, suf in (() if SKIP_BAKE else (('tex', ''), ('day', '_day'))):
    setup_look(look); S.cycles.samples = BS
    t = time.time()
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=16, use_clear=True)
    log('baked lightmap%s %dpx %d spp in %.0fs' % (suf, LM, BS, time.time() - t))
    px = np.empty(LM * LM * 4, np.float32); lm.pixels.foreach_get(px); px = px.reshape(LM, LM, 4)[..., :3]
    with open(os.path.join(OUT, 'lightmap%s.pfm' % suf), 'wb') as f:
        f.write(b'PF\n%d %d\n-1.0\n' % (LM, LM)); f.write(np.ascontiguousarray(px, '<f4').tobytes())
    log('lightmap%s stats p50 %.3f p99 %.3f max %.3f' % (suf, float(np.median(px)), float(np.percentile(px, 99)), float(px.max())))
# ---- remove bake nodes, force TEXCOORD_1 export through a tiny occlusion texture (viewer swaps in the real lightmap) ----
white = bpy.data.images.load(os.path.join(TEX, 'white.png')); white.colorspace_settings.name = 'Non-Color'
ng = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
try: ng.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
except Exception: ng.inputs.new('NodeSocketFloat', 'Occlusion')
for m, n, uvn in bnodes:
    nt = m.node_tree; nt.nodes.remove(n)
    w = nt.nodes.new('ShaderNodeTexImage'); w.image = white; nt.links.new(uvn.outputs['UV'], w.inputs['Vector'])
    sep = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(w.outputs['Color'], sep.inputs['Color'])
    g = nt.nodes.new('ShaderNodeGroup'); g.node_tree = ng; nt.links.new(sep.outputs[0], g.inputs['Occlusion'])
# ---- panorama env for reflections (three.js equirect: image centre = +X) ----
S.use_nodes = False
pc = bpy.data.cameras.new('Pano'); pc.type = 'PANO'
try: pc.panorama_type = 'EQUIRECTANGULAR'
except Exception: pc.cycles.panorama_type = 'EQUIRECTANGULAR'
po = bpy.data.objects.new('Pano', pc); COL.objects.link(po); po.location = (0.3, 0.1, 1.3); po.rotation_euler = (math.pi / 2, 0, -math.pi / 2)
S.camera = po; S.render.resolution_x, S.render.resolution_y = 1024, 512
S.render.image_settings.file_format = 'HDR'
for look, suf in ((('tex', ''),) if SKIP_BAKE else (('day', '_day'), ('tex', ''))):
    if SKIP_BAKE: setup_look(look); break
    setup_look(look); S.cycles.samples = 40; S.render.filepath = os.path.join(OUT, 'env%s.hdr' % suf)
    t = time.time(); bpy.ops.render.render(write_still=True); log('env%s.hdr %.0fs' % (suf, time.time() - t))
bpy.data.objects.remove(po)
# ---- export ----
for o in COL.objects: o.select_set(False)
kw = dict(filepath=os.path.join(OUT, 'room.glb'), export_format='GLB', use_selection=False, export_apply=True, export_cameras=False, export_lights=False,
          export_texcoords=True, export_normals=True, export_materials='EXPORT', export_yup=True,
          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6, export_draco_position_quantization=14,
          export_draco_normal_quantization=10, export_draco_texcoord_quantization=12, export_image_format='WEBP')
for im in bpy.data.images:
    try:
        if im.source == 'FILE' and im.filepath and not im.has_data: im.reload()
    except Exception: pass
# web weight: cap material textures at 1024 px (v1 GLB was 75 MB, 98% images) - lightmaps and the window photo stay full size
nsc = 0
for im in list(bpy.data.images):
    try:
        if im.source != 'FILE' or im.name.startswith('exterior') or im.name.startswith('lightmap'): continue
        w_, h_ = im.size
        if max(w_, h_) > 1024:
            k_ = 1024 / max(w_, h_); im.scale(max(1, int(w_ * k_)), max(1, int(h_ * k_))); nsc += 1
    except Exception as e: log('scale skip', im.name, str(e)[:80])
log('textures capped at 1024px:', nsc)
ok = False
for fmt in ('WEBP', 'JPEG', 'AUTO'):
    kw['export_image_format'] = fmt
    try:
        try: bpy.ops.export_scene.gltf(export_image_quality=82, **kw)
        except TypeError: bpy.ops.export_scene.gltf(**kw)
        ok = True; log('GLB exported with images as', fmt); break
    except Exception as e:
        log('GLB export failed as', fmt, str(e)[-200:])
if not ok: raise SystemExit('GLB export failed in every image format')
glb = open(os.path.join(OUT, 'room.glb'), 'rb').read()
import struct
jl = struct.unpack('<I', glb[12:16])[0]; gj = json.loads(glb[20:20 + jl])
tc1 = sum(1 for m in gj.get('meshes', []) for p in m['primitives'] if 'TEXCOORD_1' in p['attributes'])
rep = {'glb_bytes': len(glb), 'meshes': len(gj.get('meshes', [])), 'primitives_with_TEXCOORD_1': tc1, 'images': len(gj.get('images', [])),
       'materials': len(gj.get('materials', [])), 'extensionsUsed': gj.get('extensionsUsed'), 'nodes': len(gj.get('nodes', [])),
       'image_bytes': sum(gj['bufferViews'][i['bufferView']]['byteLength'] for i in gj.get('images', []) if 'bufferView' in i)}
json.dump(rep, open(os.path.join(OUT, 'glb-report.json'), 'w'), indent=1); log('GLB', rep)
# rev 1792172262302488619
