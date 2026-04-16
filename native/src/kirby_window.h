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

// Panel is a fixed 120×120 square. The ball art is drawn by the SVG loaded
// in the WKWebView, anchored on the panel geometric center (60, 60). The
// oversized bounding box lets different forms (floating / dockedExpanded /
// dockedCollapsed) paint outside the classic 80×80 circle without needing
// to resize the panel between state transitions.
static const CGFloat kKirbyPanelSize = 120.0;
static const CGFloat kKirbyAnchorX = 60.0;
static const CGFloat kKirbyAnchorY = 60.0;
static const CGFloat kKirbyBallRadius = 40.0;  // visual circular hit radius

// Convert a point from panel-local bottom-left coordinates (AppKit default)
// into the top-left coordinate space used by the asset pack docs/SVGs.
static inline NSPoint KirbyTopLeftPointFromPanelPoint(NSPoint panelPoint, NSRect panelBounds) {
    return NSMakePoint(panelPoint.x, panelBounds.size.height - panelPoint.y);
}

// Convert a global screen-space mouse point into panel-local top-left coords.
static inline NSPoint KirbyTopLeftPointFromScreenPoint(NSPoint screenPoint, NSRect panelFrame) {
    return NSMakePoint(screenPoint.x - panelFrame.origin.x,
                       NSMaxY(panelFrame) - screenPoint.y);
}

// The docked anchor coincides with Feishu's top-right corner, so the lower-left
// quadrant relative to that anchor is Feishu's interior and must stay click-through.
static inline BOOL KirbyPointIsInFeishuInterior(NSPoint panelPointTopLeft) {
    return panelPointTopLeft.x < kKirbyAnchorX && panelPointTopLeft.y > kKirbyAnchorY;
}

// Shared hit-test used by both the native drag handler and the panel content
// view. Docked states intentionally exclude the Feishu-interior quadrant so
// clicks on Feishu's own top-right controls are not stolen by vonvon.
static inline BOOL KirbyPointInHitArea(NSPoint panelPointTopLeft, KirbyState state) {
    CGFloat dx = panelPointTopLeft.x - kKirbyAnchorX;
    CGFloat dy = panelPointTopLeft.y - kKirbyAnchorY;
    BOOL insideCircle = (dx * dx + dy * dy) <= (kKirbyBallRadius * kKirbyBallRadius);
    if (!insideCircle) return NO;
    if (KirbyStateIsDocked(state) && KirbyPointIsInFeishuInterior(panelPointTopLeft)) {
        return NO;
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
- (void)syncWindowLevelForState;
- (void)orderAboveWindowNumber:(NSInteger)windowNumber;

/**
 * Switch the SVG form displayed by the embedded WKWebView. Valid values
 * mirror window.__setKirbyForm in kirby.html:
 *   "floating" | "snapping" | "dockedExpanded" | "dockedCollapsed"
 */
- (void)setForm:(NSString *)formName;

@end
