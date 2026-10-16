#define WIN32_LEAN_AND_MEAN
#include "openvr_driver.h"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {
constexpr uint16_t kPosePort = 18881;
constexpr uint32_t kWidth = 1920;
constexpr uint32_t kHeight = 1080;
constexpr char kSerial[] = "NCOM-FOCALOS-VIRTUAL-HMD-001";

#if defined(_WIN32)
using SocketHandle = SOCKET;
constexpr SocketHandle kInvalidSocket = INVALID_SOCKET;
void closeSocket(SocketHandle s) { if (s != kInvalidSocket) closesocket(s); }
#else
using SocketHandle = int;
constexpr SocketHandle kInvalidSocket = -1;
void closeSocket(SocketHandle s) { if (s != kInvalidSocket) close(s); }
#endif

class NcomHmd final : public vr::ITrackedDeviceServerDriver, public vr::IVRDisplayComponent {
public:
    NcomHmd() {
        m_pose.qWorldFromDriverRotation.w = 1.0;
        m_pose.qDriverFromHeadRotation.w = 1.0;
        m_pose.qRotation.w = 1.0;
        m_pose.result = vr::TrackingResult_Uninitialized;
        m_pose.poseIsValid = false;
        m_pose.deviceIsConnected = true;
    }

    vr::EVRInitError Activate(uint32_t objectId) override {
        m_objectId = objectId;
        auto* properties = vr::VRProperties();
        const auto container = properties->TrackedDeviceToPropertyContainer(objectId);
        properties->SetStringProperty(container, vr::Prop_ManufacturerName_String, "NCOM Systems");
        properties->SetStringProperty(container, vr::Prop_ModelNumber_String, "NCOM Focal OS Virtual HMD");
        properties->SetStringProperty(container, vr::Prop_SerialNumber_String, kSerial);
        properties->SetFloatProperty(container, vr::Prop_DisplayFrequency_Float, 90.0f);
        properties->SetFloatProperty(container, vr::Prop_UserIpdMeters_Float, 0.063f);
        properties->SetBoolProperty(container, vr::Prop_IsOnDesktop_Bool, true);
        openPoseSocket();
        vr::VRDriverLog()->Log("NCOM Focal OS virtual HMD activated; waiting for pose packets on 127.0.0.1:18881");
        return vr::VRInitError_None;
    }

    void Deactivate() override {
        closeSocket(m_socket);
        m_socket = kInvalidSocket;
#if defined(_WIN32)
        if (m_winsockStarted) {
            WSACleanup();
            m_winsockStarted = false;
        }
#endif
        m_objectId = vr::k_unTrackedDeviceIndexInvalid;
        std::lock_guard<std::mutex> lock(m_mutex);
        m_pose.poseIsValid = false;
        m_pose.deviceIsConnected = false;
        m_pose.result = vr::TrackingResult_Uninitialized;
    }

    void EnterStandby() override {}
    void DebugRequest(const char*, char* response, uint32_t size) override {
        if (response && size) response[0] = '\0';
    }

    void* GetComponent(const char* version) override {
        if (version && std::strcmp(version, vr::IVRDisplayComponent_Version) == 0)
            return static_cast<vr::IVRDisplayComponent*>(this);
        return nullptr;
    }

    vr::DriverPose_t GetPose() override {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_pose;
    }

    void PollPose() {
        if (m_socket == kInvalidSocket) return;
        bool updated = false;
        for (;;) {
            std::array<uint8_t, 128> bytes{};
#if defined(_WIN32)
            int received = recv(m_socket, reinterpret_cast<char*>(bytes.data()), static_cast<int>(bytes.size()), 0);
            if (received == SOCKET_ERROR) break;
#else
            ssize_t received = recv(m_socket, bytes.data(), bytes.size(), 0);
            if (received < 0) break;
#endif
            // Protocol is seven IEEE-754 float32 values in little-endian byte order:
            // x, y, z metres followed by quaternion w, x, y, z.
            if (received != 28) continue;
            std::array<float, 7> v{};
            std::memcpy(v.data(), bytes.data(), 28);
            bool finite = true;
            for (float x : v) finite = finite && std::isfinite(x);
            if (!finite || std::abs(v[0]) > 100.0f || std::abs(v[1]) > 100.0f || std::abs(v[2]) > 100.0f) continue;
            const double norm = std::sqrt(double(v[3]) * v[3] + double(v[4]) * v[4] +
                                          double(v[5]) * v[5] + double(v[6]) * v[6]);
            if (norm < 0.5 || norm > 1.5) continue;
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_pose.vecPosition[0] = v[0];
                m_pose.vecPosition[1] = v[1];
                m_pose.vecPosition[2] = v[2];
                m_pose.qRotation.w = v[3] / norm;
                m_pose.qRotation.x = v[4] / norm;
                m_pose.qRotation.y = v[5] / norm;
                m_pose.qRotation.z = v[6] / norm;
                m_pose.vecVelocity[0] = m_pose.vecVelocity[1] = m_pose.vecVelocity[2] = 0.0;
                m_pose.vecAngularVelocity[0] = m_pose.vecAngularVelocity[1] = m_pose.vecAngularVelocity[2] = 0.0;
                m_pose.poseTimeOffset = 0.0;
                m_pose.result = vr::TrackingResult_Running_OK;
                m_pose.poseIsValid = true;
                m_pose.deviceIsConnected = true;
            }
            updated = true; // drain the queue and submit only its newest pose
        }
        if (updated && m_objectId != vr::k_unTrackedDeviceIndexInvalid) {
            const vr::DriverPose_t pose = GetPose();
            vr::VRServerDriverHost()->TrackedDevicePoseUpdated(m_objectId, pose, sizeof(pose));
        }
    }

    // Basic virtual-display geometry. This describes an enumeration/test surface; it
    // does not implement a physical display, direct-mode compositor, or streaming transport.
    void GetWindowBounds(int32_t* x, int32_t* y, uint32_t* width, uint32_t* height) override {
        if (x) *x = 0;
        if (y) *y = 0;
        if (width) *width = kWidth;
        if (height) *height = kHeight;
    }
    bool IsDisplayOnDesktop() override { return true; }
    bool IsDisplayRealDisplay() override { return false; }
    void GetRecommendedRenderTargetSize(uint32_t* width, uint32_t* height) override {
        if (width) *width = kWidth;
        if (height) *height = kHeight;
    }
    void GetEyeOutputViewport(vr::EVREye eye, uint32_t* x, uint32_t* y, uint32_t* width, uint32_t* height) override {
        if (x) *x = eye == vr::Eye_Left ? 0u : kWidth / 2;
        if (y) *y = 0;
        if (width) *width = kWidth / 2;
        if (height) *height = kHeight;
    }
    void GetProjectionRaw(vr::EVREye, float* left, float* right, float* top, float* bottom) override {
        if (left) *left = -1.0f;
        if (right) *right = 1.0f;
        if (top) *top = -1.0f;
        if (bottom) *bottom = 1.0f;
    }
    vr::DistortionCoordinates_t ComputeDistortion(vr::EVREye, float u, float v) override {
        vr::DistortionCoordinates_t out{};
        out.rfRed[0] = out.rfGreen[0] = out.rfBlue[0] = u;
        out.rfRed[1] = out.rfGreen[1] = out.rfBlue[1] = v;
        return out;
    }
    bool ComputeInverseDistortion(vr::HmdVector2_t* result, vr::EVREye, uint32_t, float u, float v) override {
        if (!result) return false;
        result->v[0] = u;
        result->v[1] = v;
        return true;
    }

private:
    void openPoseSocket() {
        if (m_socket != kInvalidSocket) return;
#if defined(_WIN32)
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return;
        m_winsockStarted = true;
#endif
        m_socket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (m_socket == kInvalidSocket) return;
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_port = htons(kPosePort);
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (bind(m_socket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
            closeSocket(m_socket);
            m_socket = kInvalidSocket;
            return;
        }
#if defined(_WIN32)
        u_long nonBlocking = 1;
        ioctlsocket(m_socket, FIONBIO, &nonBlocking);
#else
        const int flags = fcntl(m_socket, F_GETFL, 0);
        if (flags >= 0) fcntl(m_socket, F_SETFL, flags | O_NONBLOCK);
#endif
    }

    std::mutex m_mutex;
    vr::DriverPose_t m_pose{};
    uint32_t m_objectId = vr::k_unTrackedDeviceIndexInvalid;
    SocketHandle m_socket = kInvalidSocket;
#if defined(_WIN32)
    bool m_winsockStarted = false;
#endif
};

class NcomProvider final : public vr::IServerTrackedDeviceProvider {
public:
    vr::EVRInitError Init(vr::IVRDriverContext* context) override {
        VR_INIT_SERVER_DRIVER_CONTEXT(context);
        const bool added = vr::VRServerDriverHost()->TrackedDeviceAdded(
            kSerial, vr::TrackedDeviceClass_HMD, &m_hmd);
        if (!added) return vr::VRInitError_Driver_Failed;
        vr::VRDriverLog()->Log("NCOM Focal OS virtual HMD registered as a SteamVR HMD.");
        return vr::VRInitError_None;
    }
    void Cleanup() override {
        m_hmd.Deactivate();
        VR_CLEANUP_SERVER_DRIVER_CONTEXT();
    }
    const char* const* GetInterfaceVersions() override { return vr::k_InterfaceVersions; }
    void RunFrame() override { m_hmd.PollPose(); }
    bool ShouldBlockStandbyMode() override { return false; }
    void EnterStandby() override {}
    void LeaveStandby() override {}
private:
    NcomHmd m_hmd;
};

NcomProvider g_provider;
} // namespace

#if defined(_WIN32)
#define NCOM_EXPORT extern "C" __declspec(dllexport)
#else
#define NCOM_EXPORT extern "C" __attribute__((visibility("default")))
#endif

NCOM_EXPORT void* HmdDriverFactory(const char* interfaceName, int* returnCode) {
    if (interfaceName && std::strcmp(interfaceName, vr::IServerTrackedDeviceProvider_Version) == 0)
        return &g_provider;
    if (returnCode) *returnCode = vr::VRInitError_Init_InterfaceNotFound;
    return nullptr;
}
