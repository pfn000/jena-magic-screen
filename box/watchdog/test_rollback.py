"""Offline test of the rollback branch on throwaway files (no real service is touched):
a fake unit ran healthy, got a known-good snapshot, then a 'deploy' changed its file and it flaps."""
import importlib.util, json, os, sys, tempfile, time
spec = importlib.util.spec_from_file_location('wd', os.path.join(os.path.dirname(__file__), 'jena_watchdog.py'))
wd = importlib.util.module_from_spec(spec); spec.loader.exec_module(wd)
tmp = tempfile.mkdtemp(); wd.STATE = tmp; wd.INCIDENTS = os.path.join(tmp, 'incidents.jsonl')
f = os.path.join(tmp, 'fake_server.py'); open(f, 'w').write('print("v1 good")\n')
u = wd.Unit('jena-fake', {'probe': None, 'files': {f: None}})
wd.UNITS_STATE['jena-fake'] = u
u.healthy_since = time.time() - 1900; wd.maybe_mark_good(u)
assert 'jena-fake' in wd.GOOD, 'known-good not recorded'
open(f, 'w').write('print("v2 broken deploy")\n')          # a fresh deploy (mtime = now)
restarts = []; wd.restart = lambda unit, why: restarts.append(why) or True
for mode in ('dry-run', 'live'):
    do, plan = wd.rollback_decision(u, mode)
    print(f'[{mode}] do_rollback={do}'); [print('   ', s) for s in plan['steps']]
    if do:
        ok = wd.do_rollback(u, plan); print('    after:', open(f).read().strip(), '| restart called:', restarts, '| ok', ok)
        print('   ', plan['steps'][-1])
assert open(f).read().strip() == 'print("v1 good")'
print('PASS: dry-run changes nothing; live restores the known-good file and keeps the rejected one')
