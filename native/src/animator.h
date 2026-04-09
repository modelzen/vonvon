#pragma once
#import <Cocoa/Cocoa.h>

@interface Animator : NSObject

+ (instancetype)shared;
- (void)performSnapAnimation;
- (void)performDetachAnimation;

@end
