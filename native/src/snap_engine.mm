#import "snap_engine.h"
#import "kirby_window.h"
#import "animator.h"
#import <CoreGraphics/CoreGraphics.h>

static const CGFloat kSnapDistance = 60.0;

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

    CGRect result = CGRectZero;
    NSArray *windows = (__bridge_transfer NSArray *)list;
    for (NSDictionary *info in windows) {
        NSString *owner = info[(__bridge NSString *)kCGWindowOwnerName];
        if ([owner isEqualToString:@"Lark"]   ||
            [owner isEqualToString:@"Feishu"] ||
            [owner isEqualToString:@"飞书"]) {
            NSDictionary *bd = info[(__bridge NSString *)kCGWindowBounds];
            CGRect bounds = CGRectZero;
            if (CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bd, &bounds)) {
                result = bounds;
                break;
            }
        }
    }
    return result;
}

- (void)checkSnapProximity:(NSPoint)kirbyOrigin {
    CGRect feishu = [self findFeishuWindow];
    if (CGRectIsEmpty(feishu)) {
        if (self.isInSnapZone) {
            self.isInSnapZone = NO;
            [KirbyWindow shared].state = KirbyStateFloating;
        }
        return;
    }
    self.targetFeishuBounds = feishu;

    // kirbyOrigin is NSScreen coords (bottom-left).
    // CGWindowList returns screen-space coords (top-left origin, y down).
    // For the x-axis comparison, both share the same horizontal axis.
    CGFloat feishuRight = feishu.origin.x + feishu.size.width;
    // kirby left edge in CG space = kirby NSPoint x (horizontal same)
    CGFloat kirbyLeft = kirbyOrigin.x;
    CGFloat distance  = kirbyLeft - feishuRight;

    if (fabs(distance) < kSnapDistance) {
        if (!self.isInSnapZone) {
            self.isInSnapZone = YES;
            [KirbyWindow shared].state = KirbyStateSnapping;
            // Native glow effect - scale panel up + add shadow (more reliable than JS injection)
            dispatch_async(dispatch_get_main_queue(), ^{
                NSPanel *panel = [KirbyWindow shared].panel;
                if (!panel) return;
                // Scale up: 80x80 → 96x96, centered on same point
                NSRect frame = panel.frame;
                CGFloat cx = NSMidX(frame);
                CGFloat cy = NSMidY(frame);
                NSRect enlarged = NSMakeRect(cx - 48, cy - 48, 96, 96);
                [panel setFrame:enlarged display:YES animate:NO];
                // Pink glow shadow
                panel.hasShadow = YES;
                NSView *cv = panel.contentView;
                cv.wantsLayer = YES;
                cv.layer.shadowColor = [NSColor colorWithRed:1.0 green:0.08 blue:0.58 alpha:1.0].CGColor;
                cv.layer.shadowOffset = CGSizeZero;
                cv.layer.shadowRadius = 20.0;
                cv.layer.shadowOpacity = 0.9;
            });
        }
        if (self.onSnapProximity) self.onSnapProximity(fabs(distance));
    } else {
        if (self.isInSnapZone) {
            self.isInSnapZone = NO;
            [KirbyWindow shared].state = KirbyStateFloating;
            // Remove glow: restore 80x80, remove shadow
            dispatch_async(dispatch_get_main_queue(), ^{
                NSPanel *panel = [KirbyWindow shared].panel;
                if (!panel) return;
                NSRect frame = panel.frame;
                CGFloat cx = NSMidX(frame);
                CGFloat cy = NSMidY(frame);
                NSRect restored = NSMakeRect(cx - 40, cy - 40, 80, 80);
                [panel setFrame:restored display:YES animate:NO];
                panel.hasShadow = NO;
                NSView *cv = panel.contentView;
                cv.layer.shadowOpacity = 0.0;
            });
        }
    }
}

- (void)startTrackingTimer {
    dispatch_async(dispatch_get_main_queue(), ^{
        [self stopTrackingTimer];
        self.lastFeishuBounds = [self findFeishuWindow];
        self.trackingTimer = [NSTimer scheduledTimerWithTimeInterval:0.5
            target:self selector:@selector(_tick) userInfo:nil repeats:YES];
    });
}

- (void)stopTrackingTimer {
    [self.trackingTimer invalidate];
    self.trackingTimer = nil;
}

- (void)_tick {
    if ([KirbyWindow shared].state != KirbyStateDocked) return;
    CGRect cur = [self findFeishuWindow];
    if (!CGRectEqualToRect(cur, self.lastFeishuBounds)) {
        self.lastFeishuBounds = cur;
        // Must go through performDetachAnimation so NSPanel is shown and resized
        // before the JS detach callback fires
        [[Animator shared] performDetachAnimation];
    }
}

- (void)notifySnapComplete {
    if (self.onSnapComplete) self.onSnapComplete();
}

- (void)notifyDetach {
    if (self.onDetach) self.onDetach();
}

@end
