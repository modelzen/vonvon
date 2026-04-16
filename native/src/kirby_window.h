#pragma once
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

typedef NS_ENUM(NSInteger, KirbyState) {
    KirbyStateFloating        = 0,
    KirbyStateSnapping        = 1,
    KirbyStateDockedExpanded  = 2,  // ball docked at Feishu top-right + sidebar open
    KirbyStateDockedCollapsed = 3,  // ball docked at Feishu top-right, sidebar closed
};

// Convenience: either docked state (ball glued to Feishu top-right corner).
static inline BOOL KirbyStateIsDocked(KirbyState s) {
    return s == KirbyStateDockedExpanded || s == KirbyStateDockedCollapsed;
}

// Panel is a fixed 120×120 square. The mascot art also lives in a logical
// 120×120 canvas with anchor (60, 60), but docked states shift that canvas
// inside the panel so transparent slack stays out of Feishu's click targets.
static const CGFloat kKirbyPanelSize = 120.0;
static const CGFloat kKirbyCanvasSize = 120.0;
static const CGFloat kKirbyAnchorX = 60.0;
static const CGFloat kKirbyAnchorY = 60.0;
static const CGFloat kKirbyBallRadius = 40.0;  // visual circular hit radius

// Each visual state keeps a 120×120 art canvas but may shift that canvas inside
// the fixed panel so the panel's transparent slack stays out of Feishu's own UI.
static inline NSRect KirbyCanvasFrameForState(KirbyState state) {
    switch (state) {
        case KirbyStateDockedExpanded:
            // D-shape only occupies the top strip of the art, so push the full
            // canvas down-left inside the panel. This leaves the panel's slack
            // above/right of the visible mascot instead of over Feishu controls.
            return NSMakeRect(-22.0, -60.0, kKirbyCanvasSize, kKirbyCanvasSize);
        case KirbyStateDockedCollapsed:
            // The collapsed "bite" form lives mostly in the panel's upper-right,
            // so shift the canvas slightly down-left as well.
            return NSMakeRect(-20.0, -20.0, kKirbyCanvasSize, kKirbyCanvasSize);
        default:
            return NSMakeRect(0.0, 0.0, kKirbyCanvasSize, kKirbyCanvasSize);
    }
}

// The logical Feishu contact point is always the 120×120 art canvas anchor
// (60, 60). Depending on the state's canvas offset, that anchor sits at a
// different panel-local point.
static inline NSPoint KirbyAnchorPointInPanelForState(KirbyState state) {
    NSRect canvasFrame = KirbyCanvasFrameForState(state);
    return NSMakePoint(canvasFrame.origin.x + kKirbyAnchorX,
                       canvasFrame.origin.y + kKirbyAnchorY);
}

// The docked anchor coincides with Feishu's top-right corner, so the lower-left
// quadrant relative to that anchor is Feishu's interior and must never count as
// a mascot hit, even though it still lies inside the logical circle.
static inline BOOL KirbyCanvasPointIsInFeishuInterior(NSPoint canvasPointTopLeft) {
    return canvasPointTopLeft.x < kKirbyAnchorX && canvasPointTopLeft.y > kKirbyAnchorY;
}

// Shared hit-test against the art canvas itself (top-left coordinates).
static inline BOOL KirbyCanvasPointInHitArea(NSPoint canvasPointTopLeft, KirbyState state) {
    CGFloat dx = canvasPointTopLeft.x - kKirbyAnchorX;
    CGFloat dy = canvasPointTopLeft.y - kKirbyAnchorY;
    BOOL insideCircle = (dx * dx + dy * dy) <= (kKirbyBallRadius * kKirbyBallRadius);
    if (!insideCircle) return NO;
    // The expanded D-shape is strictly above Feishu's top edge, so anything
    // below the anchor line is panel slack rather than visible mascot surface.
    if (state == KirbyStateDockedExpanded && canvasPointTopLeft.y > kKirbyAnchorY) {
        return NO;
    }
    if (KirbyStateIsDocked(state) && KirbyCanvasPointIsInFeishuInterior(canvasPointTopLeft)) {
        return NO;
    }
    return YES;
}

// Convert a panel-local bottom-left point into art-canvas top-left coordinates.
// Returns NO when the point is outside the shifted 120×120 canvas entirely,
// which means the user hit panel slack rather than the mascot artwork.
static inline BOOL KirbyPanelPointToCanvasTopLeftPoint(NSPoint panelPointBottomLeft,
                                                       KirbyState state,
                                                       NSPoint *outCanvasPointTopLeft) {
    NSRect canvasFrame = KirbyCanvasFrameForState(state);
    CGFloat canvasX = panelPointBottomLeft.x - canvasFrame.origin.x;
    CGFloat canvasYBottomLeft = panelPointBottomLeft.y - canvasFrame.origin.y;
    if (canvasX < 0.0 || canvasX > kKirbyCanvasSize ||
        canvasYBottomLeft < 0.0 || canvasYBottomLeft > kKirbyCanvasSize) {
        return NO;
    }

    if (outCanvasPointTopLeft) {
        *outCanvasPointTopLeft = NSMakePoint(canvasX,
                                             kKirbyCanvasSize - canvasYBottomLeft);
    }
    return YES;
}

@interface KirbyWindow : NSObject

@property (nonatomic, strong) NSPanel   *panel;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, assign) KirbyState state;

+ (instancetype)shared;
- (void)createAtX:(CGFloat)x y:(CGFloat)y;
- (void)destroy;
- (void)loadContentFromURL:(NSString *)urlString;
- (void)setVisible:(BOOL)visible;
- (void)evaluateJS:(NSString *)js;
- (void)applyState:(KirbyState)state preservingAnchor:(BOOL)preservingAnchor;
- (void)syncWindowLevelForState;
- (void)syncCanvasLayout;
- (void)syncCanvasLayoutPreservingAnchor;
- (void)orderAboveWindowNumber:(NSInteger)windowNumber;

/**
 * Switch the SVG form displayed by the embedded WKWebView. Valid values
 * mirror window.__setKirbyForm in kirby.html:
 *   "floating" | "snapping" | "dockedExpanded" | "dockedCollapsed"
 */
- (void)setForm:(NSString *)formName;

@end
