cmake_minimum_required(VERSION 3.25)

project(Render360PortalIOS LANGUAGES C CXX OBJC OBJCXX)

if(NOT IOS)
  message(FATAL_ERROR "Render360PortalIOS must be configured with -DCMAKE_SYSTEM_NAME=iOS")
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(RENDER360_BUNDLE_ID "com.render360.portal" CACHE STRING "iOS bundle identifier")
set(RENDER360_DEPLOYMENT_TARGET "15.0" CACHE STRING "Minimum iOS deployment target")

add_executable(Render360Portal MACOSX_BUNDLE
  Sources/main.mm
)

target_compile_definitions(Render360Portal PRIVATE
  RENDER360_IOS_NATIVE=1
  RENDER360_PORTAL_NATIVE_BOOTSTRAP=1
)

target_link_libraries(Render360Portal PRIVATE
  "-framework UIKit"
  "-framework Foundation"
  "-framework UniformTypeIdentifiers"
)

set_target_properties(Render360Portal PROPERTIES
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist"
  XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER "${RENDER360_BUNDLE_ID}"
  XCODE_ATTRIBUTE_IPHONEOS_DEPLOYMENT_TARGET "${RENDER360_DEPLOYMENT_TARGET}"
  XCODE_ATTRIBUTE_TARGETED_DEVICE_FAMILY "1,2"
  XCODE_ATTRIBUTE_ONLY_ACTIVE_ARCH "NO"
  XCODE_ATTRIBUTE_ENABLE_BITCODE "NO"
  XCODE_ATTRIBUTE_CLANG_ENABLE_OBJC_ARC "YES"
  XCODE_ATTRIBUTE_SUPPORTED_PLATFORMS "iphoneos iphonesimulator"
  XCODE_ATTRIBUTE_SUPPORTS_MACCATALYST "NO"
  XCODE_ATTRIBUTE_INFOPLIST_FILE "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist"
)

# This target intentionally contains only the native host bootstrap. Source engine
# libraries are added incrementally by the N2+ roadmap gates. Keeping N0 tiny gives
# CI a deterministic arm64/IPA proof before the engine port is layered on top.
