// /world entry: a tiny shell that lazy-loads the 3D room (src/world.js) so no other page ever pulls it in.
import './world.css';
const el = document.getElementById('world-loading');
import('./world.js')
  .then((m) => m.startWorld())
  .catch((e) => { console.error('world', e); if (el) el.textContent = "her room didn't load here (" + (e?.message || e) + '). try a newer browser?'; });
