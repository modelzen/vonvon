#import "kirby_window.h"

@implementation KirbyWindow

+ (instancetype)shared {
    static KirbyWindow *instance = nil;
    static dispatch_once_t token;
    dispatch_once(&token, ^{ instance = [[KirbyWindow alloc] init]; });
    return instance;
}

- (void)createAtX:(CGFloat)x y:(CGFloat)y {
    dispatch_async(dispatch_get_main_queue(), ^{
        // Panel is a fixed 120×120 bounding box. The SVG inside paints the
        // actual mascot in different poses for each state. See kirby_window.h
        // for rationale (oversized bbox so dockedCollapsed can protrude out
        // of the Feishu top-right corner without resizing the panel).
        NSRect frame = NSMakeRect(x, y, kKirbyPanelSize, kKirbyPanelSize);
        self.panel = [[NSPanel alloc]
            initWithContentRect:frame
            styleMask:(NSWindowStyleMaskBorderless |
                       NSWindowStyleMaskNonactivatingPanel)
            backing:NSBackingStoreBuffered
            defer:NO];

        self.panel.level                 = NSFloatingWindowLevel;
        self.panel.opaque                = NO;
        self.panel.backgroundColor       = [NSColor clearColor];
        self.panel.hasShadow             = NO;
        self.panel.collectionBehavior    = (NSWindowCollectionBehaviorCanJoinAllSpaces |
                                            NSWindowCollectionBehaviorStationary);
        self.panel.movableByWindowBackground = NO;

        // WKWebView fills the panel
        WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
        self.webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, kKirbyPanelSize, kKirbyPanelSize)
                                          configuration:cfg];
        // Transparent background. No corner-radius clip — the SVG draws the
        // ball shape directly, and clipping to a circle would hide dock-mode
        // arms/feet that poke outside the ball's nominal outline.
        [self.webView setValue:@(NO) forKey:@"drawsBackground"];
        self.webView.layer.cornerRadius  = 0.0;
        self.webView.layer.masksToBounds = NO;
        self.webView.wantsLayer          = YES;

        self.panel.contentView = self.webView;
        self.state = KirbyStateFloating;

        [self.panel orderFrontRegardless];
    });
}

- (void)destroy {
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.panel orderOut:nil];
        self.panel   = nil;
        self.webView = nil;
        self.state   = KirbyStateFloating;
    });
}

- (void)loadContentFromURL:(NSString *)urlString {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.webView) return;
        NSURL *url = [NSURL URLWithString:urlString];
        if (!url) return;
        [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
    });
}

- (void)setVisible:(BOOL)visible {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.panel) return;
        if (visible) {
            [self.panel orderFrontRegardless];
        } else {
            [self.panel orderOut:nil];
        }
    });
}

- (void)evaluateJS:(NSString *)js {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.webView) return;
        [self.webView evaluateJavaScript:js completionHandler:nil];
    });
}

- (void)setForm:(NSString *)formName {
    if (!formName) return;
    // JS-escape the form name (defensive — our values are simple ASCII).
    NSString *escaped = [formName stringByReplacingOccurrencesOfString:@"'"
                                                             withString:@"\\'"];
    NSString *js = [NSString stringWithFormat:
        @"if (typeof window.__setKirbyForm === 'function') { window.__setKirbyForm('%@'); }",
        escaped];
    [self evaluateJS:js];
}

@end
