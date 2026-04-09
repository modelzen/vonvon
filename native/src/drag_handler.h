#pragma once
#import <Cocoa/Cocoa.h>

@interface DragHandler : NSObject

+ (instancetype)shared;
- (void)startMonitoring;
- (void)stopMonitoring;

@end
