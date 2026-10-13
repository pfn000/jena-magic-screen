import os, sys, json, re, urllib.request, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done, mcp

import platform, shutil, subprocess
def sh(c):
    try: return subprocess.run(c, shell=True, capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception: return ''
mem = {l.split(':')[0]: int(l.split()[1]) // 1024 for l in open('/proc/meminfo') if l.split(':')[0] in ('MemTotal', 'MemAvailable')}
du = shutil.disk_usage(os.path.expanduser('~'))
facts = {
  'user': sh('whoami'), 'os': sh('. /etc/os-release; echo $PRETTY_NAME'), 'kernel': platform.release(), 'cpu': sh("grep -m1 'model name' /proc/cpuinfo | cut -d: -f2").strip(), 'cores': os.cpu_count(),
  'mem_mb': mem, 'disk_free_gb': round(du.free / 1e9, 1), 'python': platform.python_version(), 'node': sh('node -v'), 'display': os.environ.get('DISPLAY'),
  'gpu': sh('ls /dev/dri 2>/dev/null') or 'none (software rendering)', 'internet': sh('curl -s -m 4 -o /dev/null -w %{http_code} https://example.com') == '200',
  'sudo': sh('sudo -n true >/dev/null 2>&1 && echo yes || echo no'), 'can_write': [p for p in ['~', '/tmp', '/etc'] if os.access(os.path.expanduser(p), os.W_OK)],
  'ulimit_procs': sh('ulimit -u'), 'uptime': sh('uptime -p'),
}
done(True, f"I'm {facts['user']} on {facts['os']}, {facts['cores']} cores, {facts['mem_mb'].get('MemAvailable','?')} MB free RAM, {facts['disk_free_gb']} GB disk, GPU: {facts['gpu']}, sudo: {facts['sudo']}", facts=facts)
