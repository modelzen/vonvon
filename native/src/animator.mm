#import "animator.h"
#import "kirby_window.h"
#import "snap_engine.h"
#import <QuartzCore/QuartzCore.h>

@implementation Animator

+ (instancetype)shared {
    static Animator *instance = nil;
    static dispatch_once_t token;
    dispatch_once(&token, ^{ instance = [[Animator alloc] init]; });
    return instance;
}

- (void)performSnapAnimation {
    dispatch_async(dispatch_get_main_queue(), ^{
        KirbyWindow *kirby = [KirbyWindow shared];
        if (!kirby.panel) return;

        CGRect feishu      = [SnapEngine shared].targetFeishuBounds;
        CGFloat screenH    = NSScreen.mainScreen.frame.size.height;

        // Convert CG top-left coords → NS bottom-left coords
        NSRect target = NSMakeRect(
            feishu.origin.x + feishu.size.width,        // right of Feishu
            screenH - feishu.origin.y - feishu.size.height, // NS y
            360.0,
            feishu.size.height
        );

        [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
            ctx.duration       = 0.3;
            ctx.timingFunction = [CAMediaTimingFunction
                functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
            ctx.allowsImplicitAnimation = YES;
            [[kirby.panel animator] setFrame:target display:YES];
        } completionHandler:^{
            kirby.state = KirbyStateDocked;

            // Hide NSPanel - the JS layer will show the main BrowserWindow as sidebar
            [kirby setVisible:NO];

            [[SnapEngine shared] notifySnapComplete];
            [[SnapEngine shared] startTrackingTimer];
        }];
    });
}

- (void)performDetachAnimation {
    dispatch_async(dispatch_get_main_queue(), ^{
        KirbyWindow *kirby = [KirbyWindow shared];
        if (!kirby.panel) return;

        [[SnapEngine shared] stopTrackingTimer];
        [SnapEngine shared].isInSnapZone = NO;

        // First make panel visible again (it was hidden after snap)
        [kirby setVisible:YES];

        // Get screen center for re-positioning (panel may be at sidebar position)
        NSRect screenFrame = NSScreen.mainScreen.frame;
        CGFloat centerX = NSMidX(screenFrame) - 40;
        CGFloat centerY = NSMidY(screenFrame) - 40;

        // Reset panel to 80×80 at screen center
        NSRect target = NSMakeRect(centerX, centerY, 80, 80);

        [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
            ctx.duration       = 0.3;
            ctx.timingFunction = [CAMediaTimingFunction
                functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
            ctx.allowsImplicitAnimation = YES;
            [[kirby.panel animator] setFrame:target display:YES];
        } completionHandler:^{
            kirby.webView.frame = NSMakeRect(0, 0, 80, 80);
            kirby.webView.layer.cornerRadius = 40.0;
            kirby.state = KirbyStateFloating;
            [[SnapEngine shared] notifyDetach];
        }];
    });
}

@end
