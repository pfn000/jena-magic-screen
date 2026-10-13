# JenaXI on Kaggle (chat). Bootstrap: clone Saidie's repo (always the latest main) and run kaggle/runner.py.
# Source: https://github.com/pfn000/jena-magic-screen/tree/main/kaggle
import subprocess, sys
R = "/tmp/jena-magic-screen"
subprocess.run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", "https://github.com/pfn000/jena-magic-screen", R], check=True)
subprocess.run(["git", "-C", R, "sparse-checkout", "set", "colab", "kaggle"], check=True)
sys.exit(subprocess.call([sys.executable, "-u", R + "/kaggle/runner.py", "chat"]))
