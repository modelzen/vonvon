#pragma once
#import <Cocoa/Cocoa.h>

@interface DragHandler : NSObject

+ (instancetype)shared;
- (void)startMonitoring;
- (void)stopMonitoring;

/**
 * Fires when the user right-clicks anywhere within the Kirby panel's frame
 * (only while the panel is floating — suppressed when docked). The JS side
 * wires this up to open the standalone settings window.
 */
@property (nonatomic, copy) void (^onRightClick)(void);

@end
