# Full Linux, Steam, SteamVR and VRChat for Jena

## The important distinction

Jena's current Docker image is a Debian userspace with Xvfb/Openbox/Firefox and noVNC. It is useful as an always-on assistant box, but it is **not** a booted, full Linux PC: the container shares its host kernel and the virtual X display cannot provide a headset's direct display path, DRM leasing, USB/controller access, or real GPU acceleration on its own.

A Hugging Face Space also cannot become a remote physical gaming PC merely by installing Steam. It is a hosted application container with resource and device boundaries. Keep the Space for the web UI / model interface; run the gaming environment on a separate Linux host with the necessary hardware.

## Supported architecture

| Goal | Approach | Reality check |
|---|---|---|
| Run normal Steam games | A real Linux desktop with Steam; use native Linux builds or Proton game-by-game | Good for compatible titles; anti-cheat, launchers and DRM can block individual games |
| Run SteamVR | Linux desktop, compatible GPU/Vulkan drivers, working display compositor and headset link | SteamVR for Linux is still described by Valve as a development release with limited hardware support |
| Run VRChat in desktop mode | Steam on Linux + Proton experiment | VRChat's published minimum OS remains Windows 10/11; Linux isn't an officially supported PC OS |
| Run VRChat in a headset | Same as above plus working SteamVR, headset/display or a supported low-latency streaming path, USB/tracking/controllers as required | Not guaranteed on Linux; test the exact headset, GPU and SteamVR version before depending on it |
| Run all this in a VM | KVM/QEMU or libvirt VM with IOMMU/VFIO, a dedicated GPU passed through, and headset/USB/display devices passed through | Advanced; requires hardware and IOMMU groups that actually support passthrough. A virtual display adapter is not enough |
| Run it from the current Docker container / HF Space | Not the right layer for full PC VR | noVNC, Xvfb and a normal HTTPS tunnel are not a substitute for a physical/low-latency VR path |

## Recommended route: a real Linux gaming host

The most reliable Linux plan is a separate physical PC installed with a current Arch-based distribution and KDE Plasma, or another up-to-date distribution whose driver/compositor stack is known to work with the headset.

1. Run **./check-vr-readiness.sh** on the intended host before changing anything. Save the report.
2. Install Steam using the distribution's native package, not Steam Snap or Flatpak for SteamVR. Valve warns that the Snap and Flatpak packages break SteamVR's DRM leasing/asynchronous reprojection path.
3. Install the correct Vulkan graphics stack for the GPU. Valve currently documents proprietary NVIDIA drivers (525+) for NVIDIA; AMD/Intel should use Mesa (22.0+). Do not install AMDVLK/AMDGPU-Pro alongside Mesa for this SteamVR setup.
4. Use an X11 desktop or a compositor that supports DRM leasing. Valve lists X11 window managers, KDE Plasma Wayland and most wlroots compositors as compatible examples; its Linux support page specifically flags GNOME Wayland as unsupported for SteamVR's DRM leasing.
5. Install SteamVR from Steam and confirm the headset works before adding VRChat. Test with a simple SteamVR app first; troubleshoot the SteamVR Linux issue tracker for the exact GPU/headset combination.
6. Install VRChat from Steam and test it as a Proton compatibility experiment. VRChat's own system requirements currently list Windows 10/11, so do not label Linux VRChat as supported or guaranteed. If it fails, retain a Windows installation/dual boot as the compatibility fallback rather than weakening host security or adding random driver hacks.

Official SteamVR Linux requirements: https://help.steampowered.com/en/faqs/view/18A4-1E10-8A94-3DDA

Valve SteamVR Linux issue tracker: https://github.com/ValveSoftware/SteamVR-for-Linux

VRChat OS requirements: https://help.vrchat.com/hc/en-us/articles/1500002378722-System-Requirements

VRChat Linux/platform FAQ: https://help.vrchat.com/hc/en-us/articles/1500002379042-Is-VRChat-coming-to-PSVR-Mac-Linux-Consoles

## If a VM is mandatory

Use a Linux **host** with KVM/libvirt rather than trying to nest a full gaming VM inside Jena's existing Docker container. Before creating the guest, confirm:

- CPU and motherboard firmware expose VT-d (Intel) or AMD-Vi/IOMMU.
- The host exposes useful IOMMU groups and the gaming GPU is in a group that can be safely assigned to the VM.
- There is a separate host GPU/iGPU or another plan for the host console while the guest owns its dedicated GPU.
- The guest can receive the actual GPU, required USB controllers/devices, audio and the headset display/streaming connection.
- You can recover the host if a driver binding or VM configuration prevents the GPU from being used.

Do not automatically bind GPU devices to VFIO or alter kernel boot flags until the diagnostic report and hardware topology have been reviewed. GPU and USB passthrough can make the host console unavailable and is hardware-specific.

## Headset connection and streaming

- For a cabled PC headset, the VR machine needs the real supported display connection and USB/tracking path.
- For a compatible standalone headset (for example, Meta Quest), Steam Link can stream SteamVR from the PC; VRChat's official guide recommends having the PC and headset on the same network, ideally a good 5 GHz Wi-Fi 5/6-or-better environment. Keep the VR traffic on the LAN.
- The site's noVNC display is a **desktop-control/observation panel**, not a VR streaming protocol. A Cloudflare quick tunnel is not appropriate for 90 Hz headset streaming because VR needs very low latency and a direct display or purpose-built streaming path.

Official Quest/Steam Link instructions: https://help.vrchat.com/hc/en-us/articles/30581176449043-How-can-I-play-VRChat-wirelessly-from-my-PC

## Connection back to Jena

Keep Jena's model, memories, gateway, bot and website in the existing box. Treat the gaming host as a separate machine. Add a narrow, authenticated host-agent API only for the actions Jena actually needs (health/status, launch an approved game, report SteamVR state, request a desktop capture). Never expose SSH, VNC, Steam credentials, headset control, or a raw shell to the public Internet. Use a private LAN/VPN and an explicit allowlist for any automation.

The readiness script reports hardware/software facts; it does not modify drivers or claim that any headset or game is compatible.
