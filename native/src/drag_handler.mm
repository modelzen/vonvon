#import "drag_handler.h"
#import "kirby_window.h"
#import "snap_engine.h"
#import "animator.h"

// How far the mouse must travel after mouseDown before we classify the
// gesture as a drag (instead of a click). Used to disambiguate click-to-
// expand (in dockedCollapsed) from drag-to-detach (in any docked state).
static const CGFloat kDragStartThreshold = 8.0;

// Circular hit test against the ball art. Panel is 120×120; ball is drawn
// centered on (60, 60) with radius 40. `panelFrame` is in screen NS coords.
static BOOL PointInBallHitArea(NSPoint mouse, NSRect panelFrame) {
    CGFloat cx = panelFrame.origin.x + kKirbyPanelSize / 2;
    CGFloat cy = panelFrame.origin.y + kKirbyPanelSize / 2;
    CGFloat dx = mouse.x - cx;
    CGFloat dy = mouse.y - cy;
    return (dx * dx + dy * dy) <= (kKirbyBallRadius * kKirbyBallRadius);
}

@interface DragHandler ()
@property (nonatomic, strong) id    mouseDownMonitor;
@property (nonatomic, strong) id    mouseDragMonitor;
@property (nonatomic, strong) id    mouseUpMonitor;
@property (nonatomic, strong) id    rightMouseDownLocalMonitor;
@property (nonatomic, strong) id    rightMouseDownGlobalMonitor;
// Left button currently held down over the ball.
@property (nonatomic, assign) BOOL  mouseIsDown;
// Drag threshold already crossed for the current mouseDown.
@property (nonatomic, assign) BOOL  isDragging;
@property (nonatomic, assign) NSPoint dragOffset;
@property (nonatomic, assign) NSPoint mouseDownPoint;
@end

@implementation DragHandler

+ (instancetype)shared {
    static DragHandler *instance = nil;
    static dispatch_once_t token;
    dispatch_once(&token, ^{ instance = [[DragHandler alloc] init]; });
    return instance;
}

- (void)startMonitoring {
    __weak typeof(self) ws = self;

    // Mouse-down: accept in *any* state (including docked). We distinguish
    // "click" from "drag" later using the 8px threshold.
    self.mouseDownMonitor = [NSEvent
        addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
        handler:^NSEvent *(NSEvent *event) {
            DragHandler *s = ws;
            if (!s) return event;
            KirbyWindow *k = [KirbyWindow shared];
            if (!k.panel) return event;

            NSPoint mouse = [NSEvent mouseLocation];
            NSRect  frame = k.panel.frame;
            if (PointInBallHitArea(mouse, frame)) {
                s.mouseIsDown     = YES;
                s.isDragging      = NO;
                s.mouseDownPoint  = mouse;
                s.dragOffset      = NSMakePoint(mouse.x - frame.origin.x,
                                                mouse.y - frame.origin.y);
            }
            return event;
        }];

    self.mouseDragMonitor = [NSEvent
        addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDragged
        handler:^NSEvent *(NSEvent *event) {
            DragHandler *s = ws;
            if (!s || !s.mouseIsDown) return event;

            NSPoint mouse = [NSEvent mouseLocation];

            // Cross the drag threshold before treating this as a real drag.
            if (!s.isDragging) {
                CGFloat dx = mouse.x - s.mouseDownPoint.x;
                CGFloat dy = mouse.y - s.mouseDownPoint.y;
                if ((dx * dx + dy * dy) < (kDragStartThreshold * kDragStartThreshold)) {
                    return event;
                }
                s.isDragging = YES;

                // If we were docked, this drag-past-threshold is "tear off":
                // close the sidebar, reset state, let the ball follow the
                // mouse from here on via the normal drag pipeline.
                KirbyWindow *k = [KirbyWindow shared];
                if (KirbyStateIsDocked(k.state)) {
                    [[SnapEngine shared] stopTrackingTimer];
                    [SnapEngine shared].isInSnapZone = NO;
                    k.state = KirbyStateFloating;
                    [k setForm:@"floating"];
                    if (s.onDragLeave) s.onDragLeave();
                }
            }

            NSPoint newOrigin = NSMakePoint(mouse.x - s.dragOffset.x,
                                            mouse.y - s.dragOffset.y);
            [[KirbyWindow shared].panel setFrameOrigin:newOrigin];
            [[SnapEngine shared] checkSnapProximity:newOrigin];
            return event;
        }];

    self.mouseUpMonitor = [NSEvent
        addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseUp
        handler:^NSEvent *(NSEvent *event) {
            DragHandler *s = ws;
            if (!s || !s.mouseIsDown) return event;

            BOOL wasDragging = s.isDragging;
            s.mouseIsDown = NO;
            s.isDragging  = NO;

            if (wasDragging) {
                // Real drag ended — did it land in the snap zone?
                if ([SnapEngine shared].isInSnapZone) {
                    [[Animator shared] performSnapAnimation];
                }
                return event;
            }

            // Click (no drag). Only meaningful in dockedCollapsed:
            // transition to dockedExpanded so JS shows the sidebar.
            KirbyWindow *k = [KirbyWindow shared];
            if (k.state == KirbyStateDockedCollapsed) {
                k.state = KirbyStateDockedExpanded;
                [k setForm:@"dockedExpanded"];
                if (s.onDockedClick) s.onDockedClick();
            }
            // Other states swallow the click silently.
            return event;
        }];

    NSLog(@"[kirby] drag handler: registering right-click monitors");
    // Right-click on the Kirby panel → fire onRightClick. Two monitors are
    // needed because Kirby is a NSWindowStyleMaskNonactivatingPanel:
    //
    //   1. LOCAL monitor handles the case where vonvon happens to be the
    //      frontmost app (e.g. the user just interacted with the settings
    //      window). It can consume the event by returning nil so WKWebView
    //      doesn't also see it.
    //   2. GLOBAL monitor handles the normal case: vonvon is floating on
    //      top of Feishu/Finder and the ball is right-clicked without our
    //      app being frontmost. Global monitors are observation-only —
    //      they can't consume — so WKWebView still tries to show its
    //      "Reload" menu. kirby.html cancels that via a `contextmenu`
    //      listener that calls e.preventDefault().
    //
    // Both paths are suppressed when docked because the panel is hidden.
    BOOL (^rightClickHandler)(NSString *) = ^BOOL(NSString *source) {
        DragHandler *s = ws;
        if (!s) {
            NSLog(@"[kirby] right-click [%@]: handler self is nil", source);
            return NO;
        }
        KirbyWindow *k = [KirbyWindow shared];
        if (!k.panel) {
            NSLog(@"[kirby] right-click [%@]: panel is nil", source);
            return NO;
        }
        if (KirbyStateIsDocked(k.state)) {
            NSLog(@"[kirby] right-click [%@]: state=docked, ignoring", source);
            return NO;
        }

        NSPoint mouse = [NSEvent mouseLocation];
        NSRect  frame = k.panel.frame;
        NSLog(@"[kirby] right-click [%@]: mouse=(%.1f,%.1f) frame=(%.1f,%.1f,%.1f,%.1f)",
              source, mouse.x, mouse.y, frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);
        if (PointInBallHitArea(mouse, frame)) {
            NSLog(@"[kirby] right-click [%@]: HIT, onRightClick=%@", source, s.onRightClick ? @"set" : @"nil");
            if (s.onRightClick) s.onRightClick();
            return YES;
        }
        NSLog(@"[kirby] right-click [%@]: miss", source);
        return NO;
    };

    self.rightMouseDownLocalMonitor = [NSEvent
        addLocalMonitorForEventsMatchingMask:NSEventMaskRightMouseDown
        handler:^NSEvent *(NSEvent *event) {
            if (rightClickHandler(@"local")) {
                return nil;   // consume so WKWebView doesn't also see it
            }
            return event;
        }];

    self.rightMouseDownGlobalMonitor = [NSEvent
        addGlobalMonitorForEventsMatchingMask:NSEventMaskRightMouseDown
        handler:^(NSEvent *event) {
            rightClickHandler(@"global");
        }];
    NSLog(@"[kirby] right-click monitors registered: local=%@ global=%@",
          self.rightMouseDownLocalMonitor, self.rightMouseDownGlobalMonitor);
}

- (void)stopMonitoring {
    if (self.mouseDownMonitor) {
        [NSEvent removeMonitor:self.mouseDownMonitor];
        self.mouseDownMonitor = nil;
    }
    if (self.mouseDragMonitor) {
        [NSEvent removeMonitor:self.mouseDragMonitor];
        self.mouseDragMonitor = nil;
    }
    if (self.mouseUpMonitor) {
        [NSEvent removeMonitor:self.mouseUpMonitor];
        self.mouseUpMonitor = nil;
    }
    if (self.rightMouseDownLocalMonitor) {
        [NSEvent removeMonitor:self.rightMouseDownLocalMonitor];
        self.rightMouseDownLocalMonitor = nil;
    }
    if (self.rightMouseDownGlobalMonitor) {
        [NSEvent removeMonitor:self.rightMouseDownGlobalMonitor];
        self.rightMouseDownGlobalMonitor = nil;
    }
    self.isDragging = NO;
    self.mouseIsDown = NO;
}

@end
