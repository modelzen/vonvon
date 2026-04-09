#pragma once
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>

typedef void (^SnapProximityBlock)(CGFloat distance);
typedef void (^VoidBlock)(void);

@interface SnapEngine : NSObject

@property (nonatomic, copy)   SnapProximityBlock onSnapProximity;
@property (nonatomic, copy)   VoidBlock           onSnapComplete;
@property (nonatomic, copy)   VoidBlock           onDetach;
@property (nonatomic, assign) BOOL                isInSnapZone;
@property (nonatomic, assign) CGRect              targetFeishuBounds;
@property (nonatomic, assign) CGRect              lastFeishuBounds;

+ (instancetype)shared;
- (void)checkSnapProximity:(NSPoint)kirbyOrigin;
- (CGRect)findFeishuWindow;
- (void)startTrackingTimer;
- (void)stopTrackingTimer;
- (void)notifySnapComplete;
- (void)notifyDetach;

@end
