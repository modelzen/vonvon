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
        NSRect frame = NSMakeRect(x, y, 80, 80);
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
        self.webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 80, 80)
                                          configuration:cfg];
        // Transparent background
        [self.webView setValue:@(NO) forKey:@"drawsBackground"];
        self.webView.layer.cornerRadius  = 40.0;
        self.webView.layer.masksToBounds = YES;
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

@end
