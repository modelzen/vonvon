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
static const CGFloat kKirbyBallRadius = 40.0;  // visual circular hit radius

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

/**
 * Switch the SVG form displayed by the embedded WKWebView. Valid values
 * mirror window.__setKirbyForm in kirby.html:
 *   "floating" | "snapping" | "dockedExpanded" | "dockedCollapsed"
 */
- (void)setForm:(NSString *)formName;

@end
