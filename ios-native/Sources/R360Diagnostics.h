#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

extern NSString * const R360DiagnosticsDidChangeNotification;

@interface R360Diagnostics : NSObject

@property(nonatomic, copy, readonly) NSString *checkpoint;
@property(nonatomic, copy, readonly) NSString *gameDataState;
@property(nonatomic, copy, readonly, nullable) NSString *latestError;
@property(nonatomic, assign, readonly) NSUInteger memoryWarningCount;

+ (instancetype)sharedDiagnostics;

- (void)setCheckpoint:(NSString *)checkpoint;
- (void)setGameDataState:(NSString *)state;
- (void)setLatestError:(nullable NSString *)error;
- (void)recordMemoryWarning;
- (NSString *)formattedSummary;

@end

NS_ASSUME_NONNULL_END
