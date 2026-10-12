
import os, sys, json, glob, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import retarget
META = {
 'vetLPqfhXCc': dict(what='someone just standing around, shifting and fidgeting', kind='idle', moods=['neutral', 'relaxed'], label='standing fidget'),
 'DRyaRp3COvE': dict(what='a woman standing and waiting', kind='idle', moods=['neutral', 'relaxed', 'sad'], label='waiting'),
 'lgupcR-BIW0': dict(what='someone waiting around, kinda impatient', kind='idle', moods=['neutral', 'angry'], label='impatient wait'),
 'cIdMN8szJps': dict(what='a girl standing and waiting', kind='idle', moods=['neutral', 'relaxed'], label='waiting 2'),
 'ohASxT9tTbg': dict(what='someone talking with their hands', kind='talk', moods=['neutral', 'happy'], label='talking gestures'),
 'clp3Ysai6w0': dict(what='a woman explaining something with her hands', kind='talk', moods=['neutral', 'happy', 'surprised'], label='explaining'),
 'WrJsrsVWkGA': dict(what='someone chatting and gesturing', kind='talk', moods=['neutral', 'relaxed'], label='chatting'),
 'CNHJ72oDG_s': dict(what='someone telling a story with their hands', kind='talk', moods=['neutral', 'happy'], label='storytelling'),
 'Eu_jgIfi7SQ': dict(what='someone shifting their weight from foot to foot', kind='weight', moods=['neutral', 'relaxed'], label='weight shift'),
 'EjwQjsTQpPc': dict(what='a person shifting their weight around', kind='weight', moods=['neutral', 'relaxed'], label='weight shift 2'),
 'CPpVR1CWco8': dict(what='a girl jumping because she is happy', kind='happy', moods=['happy', 'surprised'], label='happy bounce'),
 'EYDDtTJ6TtQ_18': dict(what='a dancer warming up and stretching', kind='stretch', moods=['neutral', 'relaxed'], label='warm-up stretch'),
 'EYDDtTJ6TtQ_58': dict(what='a dancer stretching her arms and shoulders', kind='stretch', moods=['neutral', 'relaxed'], label='arm stretch'),
 'EYDDtTJ6TtQ_112': dict(what='a dancer loosening up', kind='stretch', moods=['neutral', 'happy'], label='loosen up'),
 'G74_o_43_RQ_30': dict(what='a Just Dance dancer doing "Happy"', kind='dance', moods=['happy'], label='happy dance'),
 'G74_o_43_RQ_100': dict(what='the "Happy" dance from Just Dance', kind='dance', moods=['happy', 'relaxed'], label='happy dance 2'),
 'vLo3SASoZ_E_20': dict(what='someone doing the Macarena', kind='dance', moods=['happy', 'relaxed'], label='macarena'),
 'rVBHH5DwYFA_30': dict(what='a dancer doing the Macarena', kind='dance', moods=['happy'], label='macarena 2'),
 'AhE5LVWgNzA_10': dict(what='someone doing the floss', kind='dance', moods=['happy'], label='floss'),
 'fI9fiK8Yalg_60': dict(what='a Just Dance dancer doing "Can\'t Stop the Feeling"', kind='dance', moods=['happy'], label='feeling dance'),
}
OUT = sys.argv[1] if len(sys.argv) > 1 else '/home/user/moves/out'
os.makedirs(OUT, exist_ok=True)
clips, report = [], []
for path in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'raw', '*.npz'))):
    cid = os.path.basename(path)[:-4]
    m = META.get(cid, dict(what='someone moving', kind='idle', moods=['neutral'], label=cid))
    n = len(np.load(path)['t'])
    a, b = 0.4, n / retarget.FPS - 0.4
    out, off, q, info = retarget.analyse(path, a, b)
    reasons = []
    if q['detected'] <= 0.95: reasons.append('lost the person')
    if q['vis_legs'] <= 0.55: reasons.append('legs not visible')
    if q['jitter'] >= 0.03: reasons.append('jittery tracking')
    if q['bone_cv'] >= 0.2: reasons.append('limb lengths jumping (bad depth)')
    if q['feet_in_frame'] <= 0.95: reasons.append('feet out of frame')
    if q['energy_arms'] + q['energy_body'] < 0.12: reasons.append('barely moves')
    q.pop('ok', None); report.append(dict(id=cid, ok=not reasons, reasons=reasons, **q, title=info.get('title')))
    if reasons: continue
    j = retarget.to_json(out, off, len(off))
    fn = cid + '.json'
    json.dump(j, open(os.path.join(OUT, fn), 'w'), separators=(',', ':'))
    clips.append(dict(id=cid, file=fn, label=m['label'], what=m['what'], kind=m['kind'], moods=m['moods'], duration=j['duration'],
                      mirror=True, source=dict(url=info.get('webpage_url') or info.get('url'), title=info.get('title'), channel=info.get('channel') or info.get('uploader'),
                      start=info.get('start'), end=info.get('end')), quality=dict(jitter=q['jitter'], legs_visible=q['vis_legs'], limb_stability=round(1 - q['bone_cv'], 3))))
idx = dict(version=1, note="Jena's own animation clips. Each one she built herself by watching a short public video of a real person moving, tracking their body (MediaPipe Pose, world landmarks), smoothing it and retargeting it onto her VRM bones. Bones are quaternions (x,y,z,w)*scale per frame in VRM 1.0 normalized space; hips_offset is her hips' travel over her planted feet, in leg lengths.", clips=clips)
json.dump(idx, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
json.dump(report, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'report.json'), 'w'), indent=1)
for r in report: print(('OK  ' if r['ok'] else 'REJ ') + r['id'], r['reasons'], 'jit', r['jitter'], 'legs', r['vis_legs'], 'cv', r['bone_cv'], 'E', r['energy_arms'], r['energy_body'], (r['title'] or '')[:50])
