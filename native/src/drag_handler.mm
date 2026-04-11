#import "drag_handler.h"
#import "kirby_window.h"
#import "snap_engine.h"
#import "animator.h"

@interface DragHandler ()
@property (nonatomic, strong) id    mouseDownMonitor;
@property (nonatomic, strong) id    mouseDragMonitor;
@property (nonatomic, strong) id    mouseUpMonitor;
@property (nonatomic, strong) id    rightMouseDownLocalMonitor;
@property (nonatomic, strong) id    rightMouseDownGlobalMonitor;
@property (nonatomic, assign) BOOL  isDragging;
@property (nonatomic, assign) NSPoint dragOffset;
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

    self.mouseDownMonitor = [NSEvent
        addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
        handler:^NSEvent *(NSEvent *event) {
            DragHandler *s = ws;
            if (!s) return event;
            KirbyWindow *k = [KirbyWindow shared];
            if (!k.panel || k.state == KirbyStateDocked) return event;

            NSPoint mouse = [NSEvent mouseLocation];
            NSRect  frame = k.panel.frame;
            if (NSPointInRect(mouse, frame)) {
                s.isDragging  = YES;
                s.dragOffset  = NSMakePoint(mouse.x - frame.origin.x,
                                            mouse.y - frame.origin.y);
            }
            return event;
        }];

    self.mouseDragMonitor = [NSEvent
        addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDragged
        handler:^NSEvent *(NSEvent *event) {
            DragHandler *s = ws;
            if (!s || !s.isDragging) return event;

            NSPoint mouse     = [NSEvent mouseLocation];
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
            if (!s || !s.isDragging) return event;
            s.isDragging = NO;
            if ([SnapEngine shared].isInSnapZone) {
                [[Animator shared] performSnapAnimation];
            }
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
        if (k.state == KirbyStateDocked) {
            NSLog(@"[kirby] right-click [%@]: state=docked, ignoring", source);
            return NO;
        }

        NSPoint mouse = [NSEvent mouseLocation];
        NSRect  frame = k.panel.frame;
        NSLog(@"[kirby] right-click [%@]: mouse=(%.1f,%.1f) frame=(%.1f,%.1f,%.1f,%.1f)",
              source, mouse.x, mouse.y, frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);
        if (NSPointInRect(mouse, frame)) {
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
}

@end
