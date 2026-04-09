#import "drag_handler.h"
#import "kirby_window.h"
#import "snap_engine.h"
#import "animator.h"

@interface DragHandler ()
@property (nonatomic, strong) id    mouseDownMonitor;
@property (nonatomic, strong) id    mouseDragMonitor;
@property (nonatomic, strong) id    mouseUpMonitor;
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
    self.isDragging = NO;
}

@end
