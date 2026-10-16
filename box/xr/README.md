# NCOM Focal OS, N.OS/LinuxOS, SteamVR, OpenXR and VRChat

## Target identity

The shared device identity is **NCOM Systems · NCOM Focal OS**. N.OS/LinuxOS is the PC-hybrid host platform; the OpenVR driver registers a separate virtual HMD with SteamVR. Keep these as related but distinct concepts: an operating system is not itself a physical headset.

The machine-readable target profile is in device-profile.json. It is an NCOM integration contract, **not** a Khronos OpenXR runtime manifest and not proof of hardware certification.

## What this branch implements now

- A buildable OpenVR driver prototype named ncom_focalos that registers an HMD device, advertises the NCOM Systems / NCOM Focal OS identity, and accepts a local head-pose packet on UDP 127.0.0.1:18881.
- A local OSC bridge that accepts allow-listed avatar signals over loopback HTTP and sends VRChat OSC parameters to 127.0.0.1:9000. It also listens on 127.0.0.1:9001 for avatar-change and parameter feedback.
- A stable mapping example and unit tests for OSC encoding, bundles, type validation and numeric clamping.
- A VR/AR mode contract for future runtime work.

## What remains before it is a usable full headset

**This is not yet a complete VR rendering path.** The OpenVR driver provides HMD enumeration, pose ingestion and basic virtual-display metadata. It does not currently implement a real display scan-out, a direct-mode compositor, a virtual monitor/window transport, controller/hand tracking, eye tracking or calibrated camera passthrough. SteamVR may list the virtual HMD, but do not expect arbitrary SteamVR games or VRChat VR mode to render correctly until the display/compositor path exists and is tested.

The pose endpoint requires a trusted local tracker/N.OS service to send actual sensor poses. No tracking is synthesized from these examples. If no pose packets arrive, the device reports an invalid/uninitialized pose instead of claiming tracking works.

## VR and AR runtime strategy

### VR mode

The first route is the NCOM OpenVR driver registered with SteamVR. OpenXR applications can use the active SteamVR OpenXR runtime, provided the driver and compositor implement everything the application needs. A native NCOM OpenXR runtime would be a separate major component; this branch does not implement Khronos loader/runtime negotiation.

### AR mode

OpenXR separates application rendering from environment composition. VR typically selects OPAQUE. AR typically uses ADDITIVE on an optical see-through display or ALPHA_BLEND with a camera-based underlay. Those enum values alone do not make a headset AR-capable. Focal OS must have either a real optical see-through display or a working camera passthrough feed, calibration, permissions and runtime compositor support. Advertise only blend modes actually supported by the active hardware/runtime, matching Khronos guidance:

- OpenXR environment blend modes: https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html
- OpenXR runtime discovery/manifest: https://github.com/KhronosGroup/OpenXR-SDK-Source/blob/main/specification/loader/runtime.adoc

For an initial SteamVR route, use SteamVR's OpenXR runtime. Do not point XR_RUNTIME_JSON at a JSON file that is merely a device profile; a real runtime manifest must refer to a compatible runtime library that implements loader negotiation and the OpenXR API.

## Build and test the SteamVR HMD prototype

You need the intended Windows or Linux SteamVR host. Build from a Valve OpenVR checkout:

    git clone --depth 1 https://github.com/ValveSoftware/openvr /tmp/openvr
    cmake -S box/xr/openvr-driver -B build/ncom-focalos -DOPENVR_SDK_ROOT=/tmp/openvr
    cmake --build build/ncom-focalos --config Release

CMake puts the manifest and driver binary in build/ncom-focalos. Register that folder with SteamVR's vrpathreg tool for the matching OS/architecture. Remove it with the same tool when testing is done.

**Important:** the prototype manifest makes the virtual HMD report as present. Use a dedicated test SteamVR installation or disconnect/disable other headsets before registering it. It can interfere with the currently active HMD. The current driver is an enumeration/pose milestone, not a substitute for the missing display pipeline.

## N.OS -> HMD pose protocol

The OSC bridge exposes a loopback-only HTTP route:

    POST http://127.0.0.1:8765/v1/pose
    Content-Type: application/json

    {"position":[0.0,1.65,0.0],"orientation":[1.0,0.0,0.0,0.0]}

Position is x/y/z in metres. Orientation is a quaternion in w/x/y/z order. Values must be finite, the position is limited to +/-100 metres, and quaternion magnitude must be plausible. The bridge normalizes orientation and relays seven little-endian float32 values to UDP 127.0.0.1:18881. Use only actual tracker output from N.OS. The example zero pose is just a schema illustration, not a calibration value to stream continuously.

## VRChat OSC and avatar pipeline

VRChat OSC is the avatar-expression/control channel, not the headset runtime:

- VRChat receives OSC by default on UDP 9000 and sends OSC on 9001.
- OSC avatar parameters use /avatar/parameters/PARAMETER_NAME.
- Every mapped custom parameter must actually exist in the avatar's Animator/Expression Parameters and be compatible with its bool/int/float type.

Official references:
- https://docs.vrchat.com/docs/osc-overview
- https://docs.vrchat.com/docs/osc-avatar-parameters
- https://creators.vrchat.com/avatars/

Copy avatar-mapping.example.json to avatar-mapping.json, then change the parameter names and mappings to match the eventual avatar. The example NCOM_* names are placeholders until that avatar arrives.

Run and test the OSC bridge:

    cp box/xr/avatar-mapping.example.json box/xr/avatar-mapping.json
    python3 -m unittest box/xr/test_osc_bridge.py
    python3 box/xr/osc_bridge.py

The bridge binds only to loopback, accepts only configured signal names, caps input sizes, validates scalar types and clamps configured float ranges. Do not expose its HTTP port or OSC ports directly to the internet.

### When the new avatar arrives

1. Keep the original source files, textures, licences and any author-provided Unity project intact.
2. Identify the supplied format (Unity project, FBX, VRM, Blender project, textures and animation files). Preserve the original and work from a copy.
3. Import/convert to a Unity humanoid rig as appropriate. If it is a VRM, choose a maintained VRM importer and verify materials, bones, expressions/blendshapes and licence terms rather than assuming VRM is directly uploadable.
4. Install the current official VRChat Avatars SDK in the Unity version currently supported by VRChat; add the VRC Avatar Descriptor; validate eye/view position, visemes, gestures and performance rank.
5. Add the NCOM_* expression parameters only where they are needed, define their Animator/Expression Parameter types and default values, then tailor avatar-mapping.json to those actual names.
6. Build & Test locally, validate OSC on localhost, test Desktop mode, then test in a real supported VR setup. Upload only when the model owner has granted the necessary rights and the SDK validation passes.

Official guide: https://creators.vrchat.com/avatars/creating-your-first-avatar/

Do not copy credentials or upload tokens into this repository. The avatar has not been supplied yet, so no avatar files are converted or modified by this branch.
