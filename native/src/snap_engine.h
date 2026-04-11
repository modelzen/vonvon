#pragma once
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>

typedef void (^SnapProximityBlock)(CGFloat distance);
typedef void (^VoidBlock)(void);

@interface SnapEngine : NSObject

@property (nonatomic, copy)   SnapProximityBlock onSnapProximity;
@property (nonatomic, copy)   VoidBlock           onSnapComplete;
@property (nonatomic, copy)   VoidBlock           onDetach;
// Fires when the Feishu window moves while the ball is dockedExpanded —
// native has already collapsed the sidebar and moved the ball to the new
// corner; JS uses this to hide the main BrowserWindow sidebar.
@property (nonatomic, copy)   VoidBlock           onCollapseSidebar;
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
- (void)notifyCollapseSidebar;

/**
 * Convert Feishu's CG-space bounds (top-left origin, y-down) into the NSPanel
 * origin (bottom-left, y-up) at which the 120×120 Kirby panel should sit so
 * that its geometric center (60, 60) coincides with Feishu's top-right corner.
 * Used for both the snap animation target and continuous tracking updates.
 */
- (NSPoint)dockedTopRightOriginForFeishuBounds:(CGRect)cgBounds;

@end
