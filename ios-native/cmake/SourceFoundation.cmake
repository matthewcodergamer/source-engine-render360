set(RENDER360_SOURCE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../..")
get_filename_component(RENDER360_SOURCE_ROOT "${RENDER360_SOURCE_ROOT}" ABSOLUTE)
set(RENDER360_SOURCE_COMPAT "${CMAKE_CURRENT_LIST_DIR}/../SourceCompat/R360SourceIOSPlatform.h")

add_library(r360_source_ios_platform INTERFACE)
target_compile_options(r360_source_ios_platform INTERFACE
  "$<$<COMPILE_LANGUAGE:C>:-include${RENDER360_SOURCE_COMPAT}>"
  "$<$<COMPILE_LANGUAGE:CXX>:-include${RENDER360_SOURCE_COMPAT}>"
)
target_compile_definitions(r360_source_ios_platform INTERFACE
  POSIX=1
  OSX=1
  RENDER360_SOURCE_IOS=1
)
target_include_directories(r360_source_ios_platform INTERFACE
  "${RENDER360_SOURCE_ROOT}"
  "${RENDER360_SOURCE_ROOT}/public"
  "${RENDER360_SOURCE_ROOT}/public/tier0"
  "${RENDER360_SOURCE_ROOT}/public/tier1"
  "${RENDER360_SOURCE_ROOT}/public/mathlib"
  "${RENDER360_SOURCE_ROOT}/common"
)

# N2 starts with the portable/native core of the repository's own tier0
# source inventory.  Desktop-only profilers, crash/minidump handlers and
# allocator replacement layers remain out of this first iOS foundation slice.
set(R360_TIER0_SOURCES
  "${RENDER360_SOURCE_ROOT}/tier0/commandline.cpp"
  "${RENDER360_SOURCE_ROOT}/tier0/cpu_posix.cpp"
  "${RENDER360_SOURCE_ROOT}/tier0/platform_posix.cpp"
  "${RENDER360_SOURCE_ROOT}/tier0/tier0_strtools.cpp"
  "${RENDER360_SOURCE_ROOT}/tier0/tslist.cpp"
)
add_library(r360_tier0 STATIC ${R360_TIER0_SOURCES})
target_link_libraries(r360_tier0 PUBLIC r360_source_ios_platform)
target_compile_definitions(r360_tier0 PRIVATE TIER0_STATIC_LIB=1)
set_target_properties(r360_tier0 PROPERTIES
  OUTPUT_NAME "tier0_ios"
  XCODE_ATTRIBUTE_IPHONEOS_DEPLOYMENT_TARGET "${RENDER360_DEPLOYMENT_TARGET}"
  XCODE_ATTRIBUTE_ARCHS "arm64"
  XCODE_ATTRIBUTE_SUPPORTED_PLATFORMS "iphoneos"
)

# Explicit tier1 core list derived from tier1/wscript.  This is sufficient to
# establish the true tier1->tier0 dependency without pulling filesystem or the
# engine runtime into N2.
set(R360_TIER1_SOURCES
  "${RENDER360_SOURCE_ROOT}/tier1/bitbuf.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/byteswap.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/characterset.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/checksum_crc.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/checksum_md5.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/checksum_sha1.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/commandbuffer.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/generichash.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/interface.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/lzss.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/mempool.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/rangecheckedvar.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/splitstring.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/stringpool.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/strtools.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/strtools_unicode.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/tier1.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/uniqueid.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/utlbinaryblock.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/utlbuffer.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/utlbufferutil.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/utlstring.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/utlsymbol.cpp"
  "${RENDER360_SOURCE_ROOT}/tier1/qsort_s.cpp"
)
add_library(r360_tier1 STATIC ${R360_TIER1_SOURCES})
target_link_libraries(r360_tier1 PUBLIC r360_tier0 r360_source_ios_platform)
target_compile_definitions(r360_tier1 PRIVATE TIER1_STATIC_LIB=1)
set_target_properties(r360_tier1 PROPERTIES
  OUTPUT_NAME "tier1_ios"
  XCODE_ATTRIBUTE_IPHONEOS_DEPLOYMENT_TARGET "${RENDER360_DEPLOYMENT_TARGET}"
  XCODE_ATTRIBUTE_ARCHS "arm64"
  XCODE_ATTRIBUTE_SUPPORTED_PLATFORMS "iphoneos"
)

# Portable/scalar mathlib foundation.  The repository's SIMD files include
# public/mathlib/ssemath.h, which selects sse2neon.h on AArch64, but that
# dependency is absent from this repository and its pinned thirdparty tree.
# N2 therefore does not fake an SSE implementation: SIMD translation remains
# an explicit follow-up incompatibility while this real scalar/core mathlib
# slice establishes the ARM64 build graph.
set(R360_MATHLIB_SOURCES
  "${RENDER360_SOURCE_ROOT}/mathlib/almostequal.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/anorms.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/bumpvects.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/color_conversion.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/halton.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/IceKey.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/imagequant.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/polyhedron.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/quantize.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/spherical.cpp"
  "${RENDER360_SOURCE_ROOT}/mathlib/vmatrix.cpp"
)
add_library(r360_mathlib STATIC ${R360_MATHLIB_SOURCES})
target_link_libraries(r360_mathlib PUBLIC r360_tier1 r360_tier0 r360_source_ios_platform)
target_compile_definitions(r360_mathlib PRIVATE MATHLIB_LIB=1)
set_target_properties(r360_mathlib PROPERTIES
  OUTPUT_NAME "mathlib_ios"
  XCODE_ATTRIBUTE_IPHONEOS_DEPLOYMENT_TARGET "${RENDER360_DEPLOYMENT_TARGET}"
  XCODE_ATTRIBUTE_ARCHS "arm64"
  XCODE_ATTRIBUTE_SUPPORTED_PLATFORMS "iphoneos"
)

add_custom_target(r360_source_foundation ALL
  DEPENDS r360_tier0 r360_tier1 r360_mathlib
)
