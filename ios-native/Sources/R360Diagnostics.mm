#import "R360Diagnostics.h"

#import <UIKit/UIKit.h>

#ifndef RENDER360_BUILD_IDENTIFIER
#define RENDER360_BUILD_IDENTIFIER "local"
#endif

NSString * const R360DiagnosticsDidChangeNotification = @"R360DiagnosticsDidChangeNotification";

@interface R360Diagnostics ()
@property(nonatomic, copy, readwrite) NSString *checkpoint;
@property(nonatomic, copy, readwrite) NSString *gameDataState;
@property(nonatomic, copy, readwrite, nullable) NSString *latestError;
@property(nonatomic, assign, readwrite) NSUInteger memoryWarningCount;
@end

@implementation R360Diagnostics

+ (instancetype)sharedDiagnostics {
    static R360Diagnostics *diagnostics;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        diagnostics = [[R360Diagnostics alloc] initPrivate];
    });
    return diagnostics;
}

- (instancetype)init {
    [NSException raise:NSInternalInconsistencyException format:@"Use +sharedDiagnostics"];
    return nil;
}

- (instancetype)initPrivate {
    self = [super init];
    if (self) {
        _checkpoint = @"bootstrap-created";
        _gameDataState = @"not configured";
        _memoryWarningCount = 0;
    }
    return self;
}

- (void)postChange {
    [NSNotificationCenter.defaultCenter postNotificationName:R360DiagnosticsDidChangeNotification object:self];
}

- (void)setCheckpoint:(NSString *)checkpoint {
    @synchronized (self) {
        _checkpoint = [checkpoint copy];
    }
    [self postChange];
}

- (void)setGameDataState:(NSString *)state {
    @synchronized (self) {
        _gameDataState = [state copy];
    }
    [self postChange];
}

- (void)setLatestError:(NSString * _Nullable)error {
    @synchronized (self) {
        _latestError = [error copy];
    }
    [self postChange];
}

- (void)recordMemoryWarning {
    @synchronized (self) {
        _memoryWarningCount += 1;
        _checkpoint = @"memory-warning";
    }
    [self postChange];
}

- (NSString *)architectureName {
#if defined(__arm64__) || defined(__aarch64__)
    return @"arm64";
#elif defined(__x86_64__)
    return @"x86_64";
#else
    return @"unknown";
#endif
}

- (NSString *)formattedSummary {
    NSString *checkpoint;
    NSString *gameDataState;
    NSString *latestError;
    NSUInteger memoryWarningCount;
    @synchronized (self) {
        checkpoint = [_checkpoint copy];
        gameDataState = [_gameDataState copy];
        latestError = [_latestError copy];
        memoryWarningCount = _memoryWarningCount;
    }

    NSBundle *bundle = NSBundle.mainBundle;
    NSString *version = [bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"unknown";
    NSString *build = [bundle objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"unknown";
    NSString *commit = [NSString stringWithUTF8String:RENDER360_BUILD_IDENTIFIER] ?: @"unknown";
    NSString *osVersion = UIDevice.currentDevice.systemVersion ?: @"unknown";

    return [NSString stringWithFormat:
        @"version: %@ (%@)\ncommit: %@\narchitecture: %@\niOS: %@\ncheckpoint: %@\nmemory warnings: %lu\ngame data: %@\nlatest error: %@",
        version,
        build,
        commit,
        [self architectureName],
        osVersion,
        checkpoint,
        (unsigned long)memoryWarningCount,
        gameDataState,
        latestError.length > 0 ? latestError : @"none"];
}

@end
