#pragma once
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

typedef NS_ENUM(NSInteger, KirbyState) {
    KirbyStateFloating = 0,
    KirbyStateSnapping = 1,
    KirbyStateDocked   = 2
};

@interface KirbyWindow : NSObject

@property (nonatomic, strong) NSPanel   *panel;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, assign) KirbyState state;

+ (instancetype)shared;
- (void)createAtX:(CGFloat)x y:(CGFloat)y;
- (void)destroy;
- (void)loadContentFromURL:(NSString *)urlString;
- (void)setVisible:(BOOL)visible;
- (void)evaluateJS:(NSString *)js;

@end
