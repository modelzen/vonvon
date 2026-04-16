#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <string>
#include <napi.h>
#include <node_api.h>

#import "kirby_window.h"
#import "drag_handler.h"
#import "snap_engine.h"
#import "animator.h"

// ── Threadsafe function handles ────────────────────────────────────────────
static napi_threadsafe_function g_proximityFn      = nullptr;
static napi_threadsafe_function g_completeFn       = nullptr;
static napi_threadsafe_function g_detachFn         = nullptr;
static napi_threadsafe_function g_rightClickFn     = nullptr;
static napi_threadsafe_function g_dockedClickFn    = nullptr;
static napi_threadsafe_function g_dragLeaveFn      = nullptr;
static napi_threadsafe_function g_collapseSidebarFn = nullptr;
static napi_threadsafe_function g_feishuMovedFn    = nullptr;

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
    double windowId;
    std::string windowTitle;
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
    napi_create_double(env, b->windowId, &val);
    napi_set_named_property(env, obj, "windowId", val);
    napi_value title;
    napi_create_string_utf8(env, b->windowTitle.c_str(), NAPI_AUTO_LENGTH, &title);
    napi_set_named_property(env, obj, "windowTitle", title);

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
        case KirbyStateSnapping:        return Napi::String::New(info.Env(), "snapping");
        case KirbyStateDockedExpanded:  return Napi::String::New(info.Env(), "dockedExpanded");
        case KirbyStateDockedCollapsed: return Napi::String::New(info.Env(), "dockedCollapsed");
        default:                        return Napi::String::New(info.Env(), "floating");
    }
}

// JS → Native: force the ball into a specific SVG form. Used for edge cases
// like initial load; most form changes are driven from inside the native
// state machine. Accepts "floating"|"snapping"|"dockedExpanded"|"dockedCollapsed".
Napi::Value SetKirbyForm(const Napi::CallbackInfo& info) {
    std::string form = info[0].As<Napi::String>().Utf8Value();
    NSString *nsForm = [NSString stringWithUTF8String:form.c_str()];
    [[KirbyWindow shared] setForm:nsForm];
    return info.Env().Undefined();
}

// JS → Native: trigger a short manifest-driven transition animation layered
// on top of the current visible form. This does not change Kirby's state;
// it only asks kirby.html to play a named transition (e.g. "detach").
Napi::Value PlayKirbyTransition(const Napi::CallbackInfo& info) {
    std::string name = info[0].As<Napi::String>().Utf8Value();
    NSString *nsName = [NSString stringWithUTF8String:name.c_str()];
    NSString *escaped = [nsName stringByReplacingOccurrencesOfString:@"'"
                                                          withString:@"\\'"];
    NSString *js = [NSString stringWithFormat:
        @"if (typeof window.__playKirbyTransition === 'function') { window.__playKirbyTransition('%@'); }",
        escaped];
    [[KirbyWindow shared] evaluateJS:js];
    return info.Env().Undefined();
}

// JS → Native: collapse the sidebar (triggered when user clicks the ✕ on
// the sidebar header). Updates native state and switches the SVG form;
// JS is responsible for hiding the sidebar BrowserWindow.
Napi::Value CollapseSidebar(const Napi::CallbackInfo& info) {
    dispatch_async(dispatch_get_main_queue(), ^{
        KirbyWindow *k = [KirbyWindow shared];
        // Only transition from dockedExpanded — ignore if already collapsed
        // or if user detached the ball in the meantime.
        if (k.state == KirbyStateDockedExpanded) {
            k.state = KirbyStateDockedCollapsed;
            [k setForm:@"dockedCollapsed"];
        }
    });
    return info.Env().Undefined();
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
            FeishuBounds *b = new FeishuBounds{
                fb.origin.x, fb.origin.y, fb.size.width, fb.size.height,
                (double)[SnapEngine shared].lastFeishuWindowID,
                std::string([[[SnapEngine shared].lastFeishuWindowTitle ?: @"" description] UTF8String] ?: "")};
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

// Native → JS: ball clicked while dockedCollapsed. Carries current Feishu
// bounds so JS can position the sidebar (Feishu may have moved since the
// last onSnapComplete if the user dragged Feishu while collapsed).
Napi::Value OnDockedClick(const Napi::CallbackInfo& info) {
    napi_env env = info.Env();
    if (g_dockedClickFn) {
        napi_release_threadsafe_function(g_dockedClickFn, napi_tsfn_release);
        g_dockedClickFn = nullptr;
    }
    g_dockedClickFn = MakeTsfn(env, static_cast<napi_value>(info[0]),
                                "DockedClick", CallSnapCompleteWithBounds);
    [DragHandler shared].onDockedClick = ^{
        if (g_dockedClickFn) {
            CGRect fb = [SnapEngine shared].targetFeishuBounds;
            FeishuBounds *b = new FeishuBounds{
                fb.origin.x, fb.origin.y, fb.size.width, fb.size.height,
                (double)[SnapEngine shared].lastFeishuWindowID,
                std::string([[[SnapEngine shared].lastFeishuWindowTitle ?: @"" description] UTF8String] ?: "")};
            napi_call_threadsafe_function(g_dockedClickFn, b, napi_tsfn_nonblocking);
        }
    };
    return info.Env().Undefined();
}

// Native → JS: user dragged the ball past the 8px threshold out of a
// docked state. Native has already reset state+form; JS hides the sidebar.
Napi::Value OnDragLeave(const Napi::CallbackInfo& info) {
    napi_env env = info.Env();
    if (g_dragLeaveFn) {
        napi_release_threadsafe_function(g_dragLeaveFn, napi_tsfn_release);
        g_dragLeaveFn = nullptr;
    }
    g_dragLeaveFn = MakeTsfn(env, static_cast<napi_value>(info[0]),
                              "DragLeave", CallNoArgs);
    [DragHandler shared].onDragLeave = ^{
        if (g_dragLeaveFn)
            napi_call_threadsafe_function(g_dragLeaveFn, nullptr, napi_tsfn_nonblocking);
    };
    return info.Env().Undefined();
}

// Native → JS: Feishu window moved/resized while dockedExpanded. Native
// has already moved the ball to the new corner and flipped state to
// dockedCollapsed + form dockedCollapsed; JS hides the sidebar.
Napi::Value OnCollapseSidebar(const Napi::CallbackInfo& info) {
    napi_env env = info.Env();
    if (g_collapseSidebarFn) {
        napi_release_threadsafe_function(g_collapseSidebarFn, napi_tsfn_release);
        g_collapseSidebarFn = nullptr;
    }
    g_collapseSidebarFn = MakeTsfn(env, static_cast<napi_value>(info[0]),
                                    "CollapseSidebar", CallNoArgs);
    [SnapEngine shared].onCollapseSidebar = ^{
        if (g_collapseSidebarFn)
            napi_call_threadsafe_function(g_collapseSidebarFn, nullptr, napi_tsfn_nonblocking);
    };
    return info.Env().Undefined();
}

// Native → JS: Feishu window moved/resized while dockedExpanded. Carries the
// new Feishu bounds so JS can reposition the sidebar without hiding it.
Napi::Value OnFeishuMoved(const Napi::CallbackInfo& info) {
    napi_env env = info.Env();
    if (g_feishuMovedFn) {
        napi_release_threadsafe_function(g_feishuMovedFn, napi_tsfn_release);
        g_feishuMovedFn = nullptr;
    }
    g_feishuMovedFn = MakeTsfn(env, static_cast<napi_value>(info[0]),
                                "FeishuMoved", CallSnapCompleteWithBounds);
    [SnapEngine shared].onFeishuMoved = ^(CGRect newBounds) {
        if (g_feishuMovedFn) {
            FeishuBounds *b = new FeishuBounds{
                newBounds.origin.x, newBounds.origin.y,
                newBounds.size.width, newBounds.size.height,
                (double)[SnapEngine shared].lastFeishuWindowID,
                std::string([[[SnapEngine shared].lastFeishuWindowTitle ?: @"" description] UTF8String] ?: "")};
            napi_call_threadsafe_function(g_feishuMovedFn, b, napi_tsfn_nonblocking);
        }
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
    exports.Set("setVisible",        Napi::Function::New(env, SetVisible));
    exports.Set("onRightClick",      Napi::Function::New(env, OnRightClick));
    exports.Set("onDockedClick",     Napi::Function::New(env, OnDockedClick));
    exports.Set("onDragLeave",       Napi::Function::New(env, OnDragLeave));
    exports.Set("onCollapseSidebar", Napi::Function::New(env, OnCollapseSidebar));
    exports.Set("onFeishuMoved",     Napi::Function::New(env, OnFeishuMoved));
    exports.Set("setKirbyForm",      Napi::Function::New(env, SetKirbyForm));
    exports.Set("playKirbyTransition", Napi::Function::New(env, PlayKirbyTransition));
    exports.Set("collapseSidebar",   Napi::Function::New(env, CollapseSidebar));
    return exports;
}

NODE_API_MODULE(kirby_native, Init)
