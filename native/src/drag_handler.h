#pragma once
#import <Cocoa/Cocoa.h>

@interface DragHandler : NSObject

+ (instancetype)shared;
- (void)startMonitoring;
- (void)stopMonitoring;

/**
 * Fires when the user right-clicks anywhere within the Kirby ball's circular
 * hit area (only while floating — suppressed in any docked state). The JS
 * side wires this up to open the standalone settings window.
 */
@property (nonatomic, copy) void (^onRightClick)(void);

/**
 * Fires when the user single-clicks (mouse-down/up without drag) the Kirby
 * ball while it is docked. When the ball was collapsed, native has already
 * transitioned state to KirbyStateDockedExpanded and fired
 * setForm:"dockedExpanded"; JS uses this signal to toggle the main
 * BrowserWindow sidebar.
 */
@property (nonatomic, copy) void (^onDockedClick)(void);

/**
 * Fires when the user double-clicks the Kirby ball while it is docked.
 * Native keeps the ball docked (expanding it first if it was collapsed);
 * JS uses this signal to trigger the explicit inspect-current-context flow.
 */
@property (nonatomic, copy) void (^onDockedInspect)(void);

/**
 * Fires when the user drags the Kirby ball out of a docked state (drag
 * exceeds the start threshold while KirbyStateIsDocked). Native has already
 * transitioned state to KirbyStateFloating and fired setForm:"floating";
 * JS uses this signal to hide the main BrowserWindow sidebar. The ball
 * continues to follow the mouse via the normal drag pipeline.
 */
@property (nonatomic, copy) void (^onDragLeave)(void);

@end
