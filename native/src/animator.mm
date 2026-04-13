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

        // Target: panel's geometric center lands on Feishu's top-right corner.
        CGRect feishu = [SnapEngine shared].targetFeishuBounds;
        NSPoint targetOrigin =
            [[SnapEngine shared] dockedTopRightOriginForFeishuBounds:feishu];
        NSRect target = NSMakeRect(
            targetOrigin.x, targetOrigin.y,
            kKirbyPanelSize, kKirbyPanelSize);

        [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
            ctx.duration       = 0.3;
            ctx.timingFunction = [CAMediaTimingFunction
                functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
            ctx.allowsImplicitAnimation = YES;
            [[kirby.panel animator] setFrame:target display:YES];
        } completionHandler:^{
            // Ball remains visible — it stays glued to the Feishu top-right
            // corner from now on. The JS layer will show the sidebar
            // BrowserWindow in response to notifySnapComplete.
            kirby.state = KirbyStateDockedExpanded;
            [kirby setForm:@"dockedExpanded"];
            if ([SnapEngine shared].lastFeishuWindowID != kCGNullWindowID) {
                [kirby orderAboveWindowNumber:(NSInteger)[SnapEngine shared].lastFeishuWindowID];
            }

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

        // The panel is already visible in the new flow (we no longer hide it
        // after snap), but make sure — defensive against legacy paths.
        [kirby setVisible:YES];

        // Re-center the ball on screen at 120×120.
        NSRect screenFrame = NSScreen.mainScreen.frame;
        CGFloat half = kKirbyPanelSize / 2;
        CGFloat centerX = NSMidX(screenFrame) - half;
        CGFloat centerY = NSMidY(screenFrame) - half;
        NSRect target = NSMakeRect(centerX, centerY, kKirbyPanelSize, kKirbyPanelSize);

        [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
            ctx.duration       = 0.3;
            ctx.timingFunction = [CAMediaTimingFunction
                functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
            ctx.allowsImplicitAnimation = YES;
            [[kirby.panel animator] setFrame:target display:YES];
        } completionHandler:^{
            kirby.webView.frame = NSMakeRect(0, 0, kKirbyPanelSize, kKirbyPanelSize);
            // No corner-radius clip — SVG draws the shape (see kirby_window.mm).
            kirby.webView.layer.cornerRadius = 0.0;
            kirby.webView.layer.masksToBounds = NO;
            kirby.state = KirbyStateFloating;
            [kirby setForm:@"floating"];
            [[SnapEngine shared] notifyDetach];
        }];
    });
}

@end
