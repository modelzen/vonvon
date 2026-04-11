#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <napi.h>
#include <node_api.h>

#import "kirby_window.h"
#import "drag_handler.h"
#import "snap_engine.h"
#import "animator.h"

// ── Threadsafe function handles ────────────────────────────────────────────
static napi_threadsafe_function g_proximityFn  = nullptr;
static napi_threadsafe_function g_completeFn   = nullptr;
static napi_threadsafe_function g_detachFn     = nullptr;
static napi_threadsafe_function g_rightClickFn = nullptr;

// CallJs: snap-proximity  (data = heap-alloc'd double*)
static void CallSnapProximity(napi_env env, napi_value jsCb,
                               void* /*ctx*/, void* data) {
    if (!env || !data) return;
    double dist = *static_cast<double*>(data);
    delete static_cast<double*>(data);
    napi_value arg;
    napi_create_double(env, dist, &arg);
    napi_value global;
    napi_get_global(env, &global);
    napi_call_function(env, global, jsCb, 1, &arg, nullptr);
}

// CallJs: no-arg callbacks (detach)
static void CallNoArgs(napi_env env, napi_value jsCb,
                       void* /*ctx*/, void* /*data*/) {
    if (!env) return;
    napi_value global;
    napi_get_global(env, &global);
    napi_call_function(env, global, jsCb, 0, nullptr, nullptr);
}

// Struct to pass feishu bounds from native to JS
struct FeishuBounds {
    double x, y, width, height;
};

// CallJs: snap-complete with feishu bounds
static void CallSnapCompleteWithBounds(napi_env env, napi_value jsCb,
                                        void* /*ctx*/, void* data) {
    if (!env || !data) return;
    FeishuBounds *b = static_cast<FeishuBounds*>(data);

    napi_value obj;
    napi_create_object(env, &obj);

    napi_value val;
    napi_create_double(env, b->x, &val);
    napi_set_named_property(env, obj, "x", val);
    napi_create_double(env, b->y, &val);
    napi_set_named_property(env, obj, "y", val);
    napi_create_double(env, b->width, &val);
    napi_set_named_property(env, obj, "width", val);
    napi_create_double(env, b->height, &val);
    napi_set_named_property(env, obj, "height", val);

    delete b;

    napi_value global;
    napi_get_global(env, &global);
    napi_call_function(env, global, jsCb, 1, &obj, nullptr);
}

static napi_threadsafe_function MakeTsfn(napi_env env, napi_value jsCb,
                                          const char* name,
                                          napi_threadsafe_function_call_js callJs) {
    napi_value resName;
    napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resName);
    napi_threadsafe_function fn = nullptr;
    napi_create_threadsafe_function(env, jsCb, nullptr, resName,
                                    0, 1, nullptr, nullptr, nullptr,
                                    callJs, &fn);
    return fn;
}

// ── N-API exports ───────────────────────────────────────────────────────────

Napi::Value CreateKirbyWindow(const Napi::CallbackInfo& info) {
    double x = info[0].As<Napi::Number>().DoubleValue();
    double y = info[1].As<Napi::Number>().DoubleValue();
    [[KirbyWindow shared] createAtX:(CGFloat)x y:(CGFloat)y];
    [[DragHandler shared] startMonitoring];
    return info.Env().Undefined();
}

Napi::Value DestroyKirbyWindow(const Napi::CallbackInfo& info) {
    [[DragHandler shared] stopMonitoring];
    [[SnapEngine  shared] stopTrackingTimer];
    [[KirbyWindow shared] destroy];
    return info.Env().Undefined();
}

Napi::Value GetKirbyState(const Napi::CallbackInfo& info) {
    switch ([KirbyWindow shared].state) {
        case KirbyStateSnapping: return Napi::String::New(info.Env(), "snapping");
        case KirbyStateDocked:   return Napi::String::New(info.Env(), "docked");
        default:                 return Napi::String::New(info.Env(), "floating");
    }
}

Napi::Value LoadContent(const Napi::CallbackInfo& info) {
    std::string url = info[0].As<Napi::String>().Utf8Value();
    NSString *nsUrl = [NSString stringWithUTF8String:url.c_str()];
    [[KirbyWindow shared] loadContentFromURL:nsUrl];
    return info.Env().Undefined();
}

Napi::Value OnSnapProximity(const Napi::CallbackInfo& info) {
    napi_env env = info.Env();
    if (g_proximityFn) {
        napi_release_threadsafe_function(g_proximityFn, napi_tsfn_release);
        g_proximityFn = nullptr;
    }
    g_proximityFn = MakeTsfn(env, static_cast<napi_value>(info[0]),
                              "SnapProximity", CallSnapProximity);
    [SnapEngine shared].onSnapProximity = ^(CGFloat dist) {
        if (!g_proximityFn) return;
        double *d = new double(static_cast<double>(dist));
        napi_call_threadsafe_function(g_proximityFn, d, napi_tsfn_nonblocking);
    };
    return info.Env().Undefined();
}

Napi::Value OnSnapComplete(const Napi::CallbackInfo& info) {
    napi_env env = info.Env();
    if (g_completeFn) {
        napi_release_threadsafe_function(g_completeFn, napi_tsfn_release);
        g_completeFn = nullptr;
    }
    g_completeFn = MakeTsfn(env, static_cast<napi_value>(info[0]),
                             "SnapComplete", CallSnapCompleteWithBounds);
    [SnapEngine shared].onSnapComplete = ^{
        if (g_completeFn) {
            CGRect fb = [SnapEngine shared].targetFeishuBounds;
            FeishuBounds *b = new FeishuBounds{fb.origin.x, fb.origin.y, fb.size.width, fb.size.height};
            napi_call_threadsafe_function(g_completeFn, b, napi_tsfn_nonblocking);
        }
    };
    return info.Env().Undefined();
}

Napi::Value SetVisible(const Napi::CallbackInfo& info) {
    bool visible = info[0].As<Napi::Boolean>().Value();
    [[KirbyWindow shared] setVisible:visible];
    return info.Env().Undefined();
}

Napi::Value OnDetach(const Napi::CallbackInfo& info) {
    napi_env env = info.Env();
    if (g_detachFn) {
        napi_release_threadsafe_function(g_detachFn, napi_tsfn_release);
        g_detachFn = nullptr;
    }
    g_detachFn = MakeTsfn(env, static_cast<napi_value>(info[0]),
                           "Detach", CallNoArgs);
    [SnapEngine shared].onDetach = ^{
        if (g_detachFn)
            napi_call_threadsafe_function(g_detachFn, nullptr, napi_tsfn_nonblocking);
    };
    return info.Env().Undefined();
}

Napi::Value DetachToFloating(const Napi::CallbackInfo& info) {
    [[Animator shared] performDetachAnimation];
    return info.Env().Undefined();
}

Napi::Value OnRightClick(const Napi::CallbackInfo& info) {
    napi_env env = info.Env();
    if (g_rightClickFn) {
        napi_release_threadsafe_function(g_rightClickFn, napi_tsfn_release);
        g_rightClickFn = nullptr;
    }
    g_rightClickFn = MakeTsfn(env, static_cast<napi_value>(info[0]),
                               "RightClick", CallNoArgs);
    [DragHandler shared].onRightClick = ^{
        if (g_rightClickFn)
            napi_call_threadsafe_function(g_rightClickFn, nullptr, napi_tsfn_nonblocking);
    };
    return info.Env().Undefined();
}

// ── Module init ─────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("createKirbyWindow", Napi::Function::New(env, CreateKirbyWindow));
    exports.Set("destroyKirbyWindow",Napi::Function::New(env, DestroyKirbyWindow));
    exports.Set("getKirbyState",     Napi::Function::New(env, GetKirbyState));
    exports.Set("loadContent",       Napi::Function::New(env, LoadContent));
    exports.Set("onSnapProximity",   Napi::Function::New(env, OnSnapProximity));
    exports.Set("onSnapComplete",    Napi::Function::New(env, OnSnapComplete));
    exports.Set("onDetach",          Napi::Function::New(env, OnDetach));
    exports.Set("detachToFloating",  Napi::Function::New(env, DetachToFloating));
    exports.Set("setVisible",       Napi::Function::New(env, SetVisible));
    exports.Set("onRightClick",      Napi::Function::New(env, OnRightClick));
    return exports;
}

NODE_API_MODULE(kirby_native, Init)
