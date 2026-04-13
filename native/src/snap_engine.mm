#import "snap_engine.h"
#import "kirby_window.h"
#import "animator.h"
#import <CoreGraphics/CoreGraphics.h>

static const CGFloat kSnapDistance = 60.0;
// How often we poll Feishu's bounds while the ball is docked, so the ball
// smoothly tracks Feishu when the user drags the window around. 33 ms ≈ 30fps,
// a balance between visual smoothness and CPU cost of CGWindowListCopyWindowInfo.
static const NSTimeInterval kDockedTrackingInterval = 1.0 / 30.0;

@interface SnapEngine ()
@property (nonatomic, strong) NSTimer *trackingTimer;
@end

@implementation SnapEngine

+ (instancetype)shared {
    static SnapEngine *instance = nil;
    static dispatch_once_t token;
    dispatch_once(&token, ^{ instance = [[SnapEngine alloc] init]; });
    return instance;
}

- (CGRect)findFeishuWindow {
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);
    if (!list) return CGRectZero;

    // Lark/Feishu registers multiple windows under the same owner name:
    // the main chat window (layer 0, full size), a menubar status-item
    // (~24×24 at screen top, layer 25), a floating mini window, toast
    // popups, etc. We want the main window, so we:
    //   1. Only consider layer == 0 (normal app window level).
    //   2. Require a minimum size (main window is at least 400×300).
    //   3. Pick the largest area if multiple qualify (handles the "mini
    //      chat" window being also layer 0 on some builds).
    CGRect best = CGRectZero;
    CGFloat bestArea = 0;
    CGWindowID bestID = kCGNullWindowID;
    NSArray *windows = (__bridge_transfer NSArray *)list;
    for (NSDictionary *info in windows) {
        NSString *owner = info[(__bridge NSString *)kCGWindowOwnerName];
        if (![owner isEqualToString:@"Lark"]   &&
            ![owner isEqualToString:@"Feishu"] &&
            ![owner isEqualToString:@"飞书"]) continue;

        NSNumber *layer = info[(__bridge NSString *)kCGWindowLayer];
        if (layer && [layer intValue] != 0) continue;

        NSDictionary *bd = info[(__bridge NSString *)kCGWindowBounds];
        CGRect bounds = CGRectZero;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bd, &bounds)) continue;
        if (bounds.size.width < 400 || bounds.size.height < 300) continue;

        CGFloat area = bounds.size.width * bounds.size.height;
        if (area > bestArea) {
            best = bounds;
            bestArea = area;
            NSNumber *wid = info[(__bridge NSString *)kCGWindowNumber];
            bestID = wid ? (CGWindowID)[wid unsignedIntValue] : kCGNullWindowID;
        }
    }
    self.lastFeishuWindowID = bestID;
    return best;
}

- (void)checkSnapProximity:(NSPoint)kirbyOrigin {
    CGRect feishu = [self findFeishuWindow];
    if (CGRectIsEmpty(feishu)) {
        if (self.isInSnapZone) {
            self.isInSnapZone = NO;
            [KirbyWindow shared].state = KirbyStateFloating;
            [[KirbyWindow shared] setForm:@"floating"];
        }
        return;
    }
    self.targetFeishuBounds = feishu;

    // Panel is 120×120; the ball art is centered on (60, 60) with radius 40,
    // so its visual left edge sits at panel.origin.x + 20.
    // kirbyOrigin is NSScreen coords (bottom-left); horizontally equivalent
    // to CG space.
    CGFloat feishuRight = feishu.origin.x + feishu.size.width;
    CGFloat visualBallLeft = kirbyOrigin.x + (kKirbyPanelSize / 2 - kKirbyBallRadius);
    CGFloat distance  = visualBallLeft - feishuRight;

    if (fabs(distance) < kSnapDistance) {
        if (!self.isInSnapZone) {
            self.isInSnapZone = YES;
            [KirbyWindow shared].state = KirbyStateSnapping;
            [[KirbyWindow shared] setForm:@"snapping"];
        }
        if (self.onSnapProximity) self.onSnapProximity(fabs(distance));
    } else {
        if (self.isInSnapZone) {
            self.isInSnapZone = NO;
            [KirbyWindow shared].state = KirbyStateFloating;
            [[KirbyWindow shared] setForm:@"floating"];
        }
    }
}

- (NSPoint)dockedTopRightOriginForFeishuBounds:(CGRect)cgBounds {
    // cgBounds is in CG coords (global, top-left origin, y-down).
    // Top-right corner in CG:
    CGFloat trX = cgBounds.origin.x + cgBounds.size.width;
    CGFloat trY = cgBounds.origin.y;

    // Convert to global NS coords (bottom-left origin, y-up).
    //
    // Both CG and NS global coordinate systems are anchored to the
    // PRIMARY screen (the one with the menubar): CG y=0 at its top,
    // NS y=0 at its bottom. They stay globally consistent across all
    // attached displays — a point on a secondary monitor still flips
    // via primary height. So the correct formula is:
    //
    //     nsY = primaryScreenHeight - cgY
    //
    // NOT NSScreen.mainScreen height. mainScreen is the screen holding
    // the key window, which on a multi-monitor setup can be the
    // secondary display, giving the wrong flip height and parking the
    // ball far above (or below) Feishu's top-right corner.
    NSScreen *primary = [[NSScreen screens] firstObject];
    CGFloat primaryH = primary ? primary.frame.size.height
                               : NSScreen.mainScreen.frame.size.height;
    CGFloat nsY = primaryH - trY;

    // Panel origin = center - (size/2, size/2); center = Feishu top-right.
    CGFloat half = kKirbyPanelSize / 2;
    return NSMakePoint(trX - half, nsY - half);
}

- (void)startTrackingTimer {
    dispatch_async(dispatch_get_main_queue(), ^{
        [self stopTrackingTimer];
        self.lastFeishuBounds = [self findFeishuWindow];
        self.trackingTimer = [NSTimer scheduledTimerWithTimeInterval:kDockedTrackingInterval
            target:self selector:@selector(_tick) userInfo:nil repeats:YES];
    });
}

- (void)stopTrackingTimer {
    [self.trackingTimer invalidate];
    self.trackingTimer = nil;
}

- (void)_tick {
    KirbyState st = [KirbyWindow shared].state;
    if (!KirbyStateIsDocked(st)) return;

    CGRect cur = [self findFeishuWindow];

    // Feishu is gone (minimized/hidden/quit). Fall out to floating via the
    // full detach animation so the user sees the ball fly back to center.
    if (CGRectIsEmpty(cur)) {
        [[Animator shared] performDetachAnimation];
        return;
    }

    // Another app covering Feishu's top-right corner does NOT change the
    // docked state. We intentionally keep both the ball and sidebar attached
    // until Feishu actually disappears or the user explicitly detaches.
    if (self.lastFeishuWindowID != kCGNullWindowID) {
        [[KirbyWindow shared] orderAboveWindowNumber:(NSInteger)self.lastFeishuWindowID];
    }

    // No change — nothing to do (cheap path, runs 30x/sec while docked).
    if (CGRectEqualToRect(cur, self.lastFeishuBounds)) return;

    self.lastFeishuBounds = cur;
    self.targetFeishuBounds = cur;

    // Feishu moved or resized: keep the ball glued to the new top-right
    // corner by snapping its origin (no animation — this runs at 30fps).
    NSPoint newOrigin = [self dockedTopRightOriginForFeishuBounds:cur];
    NSPanel *panel = [KirbyWindow shared].panel;
    if (panel) {
        [panel setFrameOrigin:newOrigin];
    }

    // Feishu moved/resized while sidebar is expanded — notify JS to reposition
    // the sidebar so it follows the Feishu window. State stays dockedExpanded.
    if (st == KirbyStateDockedExpanded) {
        if (self.onFeishuMoved) self.onFeishuMoved(cur);
    }
}

- (void)notifySnapComplete {
    if (self.onSnapComplete) self.onSnapComplete();
}

- (void)notifyDetach {
    if (self.onDetach) self.onDetach();
}

- (void)notifyCollapseSidebar {
    if (self.onCollapseSidebar) self.onCollapseSidebar();
}

@end
