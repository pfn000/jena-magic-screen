cmake_minimum_required(VERSION 3.16)
project(ncom_focalos_openvr_driver LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(OPENVR_SDK_ROOT "" CACHE PATH "Path to ValveSoftware/openvr checkout")

if(NOT EXISTS "${OPENVR_SDK_ROOT}/headers/openvr_driver.h")
  message(FATAL_ERROR "Set OPENVR_SDK_ROOT to a ValveSoftware/openvr checkout containing headers/openvr_driver.h")
endif()

if(WIN32)
  set(NCOM_ARCH win64)
elseif(APPLE)
  set(NCOM_ARCH osx)
else()
  set(NCOM_ARCH linux64)
endif()

add_library(driver_ncom_focalos SHARED src/ncom_focalos_driver.cpp)
target_include_directories(driver_ncom_focalos PRIVATE "${OPENVR_SDK_ROOT}/headers")
if(WIN32)
  target_link_libraries(driver_ncom_focalos PRIVATE ws2_32)
endif()

set(NCOM_DRIVER_DIR "${CMAKE_BINARY_DIR}/ncom_focalos")
set_target_properties(driver_ncom_focalos PROPERTIES
  PREFIX ""
  LIBRARY_OUTPUT_DIRECTORY "${NCOM_DRIVER_DIR}/bin/${NCOM_ARCH}"
  RUNTIME_OUTPUT_DIRECTORY "${NCOM_DRIVER_DIR}/bin/${NCOM_ARCH}"
)
file(MAKE_DIRECTORY "${NCOM_DRIVER_DIR}")
configure_file(driver.vrdrivermanifest "${NCOM_DRIVER_DIR}/driver.vrdrivermanifest" COPYONLY)
