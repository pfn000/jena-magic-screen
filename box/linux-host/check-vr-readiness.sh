#!/usr/bin/env bash
# Read-only host diagnostics for real Linux gaming/SteamVR readiness.
# Does not install software, change drivers, bind PCI devices, or alter boot settings.
set -u

section() { printf '\n== %s ==\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
run_if() {
  local cmd="$1"; shift
  if have "$cmd"; then "$cmd" "$@" 2>&1 || true
  else printf '%s: not installed\n' "$cmd"
  fi
}

section "OS / kernel / virtualisation"
cat /etc/os-release 2>/dev/null | sed -n '1,8p' || true
uname -a
if have systemd-detect-virt; then systemd-detect-virt || true; fi
printf 'Kernel KVM device: '
if [[ -e /dev/kvm ]]; then ls -l /dev/kvm; else echo "missing (KVM VM acceleration is unavailable here)"; fi

section "CPU and memory"
run_if lscpu
if have free; then free -h; fi
if have df; then df -h / /home 2>/dev/null || df -h /; fi

section "GPU / Vulkan / display"
run_if lspci -nnk
run_if nvidia-smi
run_if vulkaninfo --summary
run_if glxinfo -B
printf '\nDRM nodes:\n'
if compgen -G '/dev/dri/*' >/dev/null; then ls -l /dev/dri/; else echo "No /dev/dri nodes visible"; fi
printf '\nDisplay environment: DISPLAY=%s WAYLAND_DISPLAY=%s XDG_SESSION_TYPE=%s\n' \
  "${DISPLAY:-unset}" "${WAYLAND_DISPLAY:-unset}" "${XDG_SESSION_TYPE:-unset}"
printf '\nConnected DRM connectors (status):\n'
if compgen -G '/sys/class/drm/card*-*/status' >/dev/null; then
  for f in /sys/class/drm/card*-*/status; do printf '%s: ' "${f%/status}"; cat "$f"; done
else echo "No DRM connector status files"; fi

section "IOMMU / passthrough readiness"
printf 'Kernel command line: '; cat /proc/cmdline 2>/dev/null || true
if compgen -G '/sys/kernel/iommu_groups/*' >/dev/null; then
  printf 'IOMMU groups found: %s\n' "$(find /sys/kernel/iommu_groups -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
else
  echo "No IOMMU groups found; PCI passthrough has not been verified."
fi
printf '\nUSB devices:\n'
run_if lsusb

section "Steam / VR runtimes"
run_if steam --version
if [[ -d "$HOME/.steam/steam/steamapps/common/SteamVR" ]]; then
  echo "SteamVR installation found under ~/.steam/steam/steamapps/common/SteamVR"
else
  echo "SteamVR not found at the usual per-user Steam path."
fi
if [[ -d "$HOME/.steam/steam/steamapps/common/VRChat" ]]; then
  echo "VRChat installation found under ~/.steam/steam/steamapps/common/VRChat"
else
  echo "VRChat not found at the usual per-user Steam path."
fi

section "Result"
echo "This report is diagnostic only. Passing these checks does not guarantee headset, SteamVR, Proton, or VRChat compatibility."
echo "For real PC VR, verify the actual GPU, active display/DRM leasing path, headset connection, and per-title compatibility."
