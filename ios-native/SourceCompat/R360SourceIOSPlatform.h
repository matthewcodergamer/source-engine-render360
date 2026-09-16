#pragma once

#include <TargetConditionals.h>

#if !TARGET_OS_IOS
#error "Render360 Source foundation targets require iOS"
#endif

#if TARGET_OS_SIMULATOR
#error "Render360 Source foundation targets require physical iPhoneOS"
#endif

#if !defined(__aarch64__)
#error "Render360 Source foundation targets require arm64"
#endif

/*
 * This Source branch predates iOS support and uses POSIX/OSX as its Darwin
 * feature switches.  Keep those compatibility defines centralized here
 * instead of scattering them through Valve source files.  OSX here means
 * "Darwin APIs/header layout" to the legacy Source platform layer; it does
 * not mean that the target is macOS.
 */
#ifndef POSIX
#define POSIX 1
#endif

#ifndef OSX
#define OSX 1
#endif

#define RENDER360_SOURCE_IOS 1
