# JenaXI on Kaggle (chat). Bootstrap: fetch the runner from Saidie's repo and run it.
# Source: https://github.com/pfn000/jena-magic-screen/tree/main/kaggle
import subprocess, sys, urllib.request
src = urllib.request.urlopen("https://raw.githubusercontent.com/pfn000/jena-magic-screen/main/kaggle/runner.py", timeout=60).read()
open("/tmp/jena_runner.py", "wb").write(src)
sys.exit(subprocess.call([sys.executable, "-u", "/tmp/jena_runner.py", "chat"]))
