# The On-Device Automation Harness

*An architecture walk-through of Cromite's `headless-automation-mode`*

---

## Preface

Most browser automation lives *outside* the browser: a desktop script speaks WebDriver
over a socket and puppets the app from across the room. This feature does the opposite.
It moves the puppeteer **inside** Cromite, onto the screen itself, as a small web app that
rides on top of whatever page you are visiting.

The design rests on a single sentence you should keep in mind for the rest of this book:

> **The page is the canvas, JavaScript is the brain, and native Android is the hands.**

- The **canvas** is an HTML page (`harness.html`) shown in a `WebView` laid over the tab.
- The **brain** is the JavaScript in that page: it owns the flows, the run loop, and the
  add/remove/update of flows. Nothing about *what to automate* lives in compiled code.
- The **hands** are native Android primitives that locate elements and then deliver *real*
  taps and keystrokes — `MotionEvent`s and `KeyEvent`s through the ordinary input pipeline,
  with randomized timing and a little coordinate jitter, so the renderer sees `isTrusted`
  events indistinguishable from a human's.

A note on intent and scope: the "human-like" behaviour here is ordinary
automation-quality pacing for **personal use** — typing that isn't robotically uniform,
taps that aren't pixel-perfect. It is not, and is not meant to be, a tool for defeating a
particular site's bot defences or solving CAPTCHAs.

```mermaid
flowchart TB
    User([You]):::human
    subgraph Overlay["Harness overlay (on top of the tab)"]
        HTML["harness.html<br/><i>flows • run loop • UI</i>"]:::js
    end
    Bridge["AutomationBridge<br/><i>window.automationNative</i>"]:::java
    Engine["AutomationEngine<br/><i>locate • inject input</i>"]:::java
    Tab["Tab WebContents"]:::cpp
    Renderer["Renderer<br/><i>the live web page</i>"]:::renderer
    ExtDoor["window.cromite<br/><i>(external WebDriver/Appium)</i>"]:::cpp

    User -->|taps a flow| HTML
    HTML -->|"primitive(args, id)"| Bridge
    Bridge --> Engine
    Engine -->|"evaluateJavaScript (locate/read)"| Tab
    Engine -->|"MotionEvent / KeyEvent (act)"| Tab
    Tab --> Renderer
    Engine -.->|"__automationResolve(id)"| HTML
    ExtDoor -.->|"setContentVisible"| Bridge

    classDef human fill:#ECECEC,stroke:#888,color:#222;
    classDef js fill:#FFE9B8,stroke:#C8901A,color:#5A3E00;
    classDef java fill:#CFE4FF,stroke:#2E6BB8,color:#0A2A4D;
    classDef cpp fill:#CFEFD6,stroke:#2E9E54,color:#0C3D1E;
    classDef renderer fill:#E5E5EA,stroke:#888,color:#333;
```

**Takeaway:** every arrow that *reads* the page is JavaScript; every arrow that *acts on*
the page is a real Android input event. Hold that distinction and the rest follows.

---

## Chapter 1 · The Cast of Files

The feature is a single Cromite patch, `Add-headless-automation-mode.patch`, but it touches
four worlds: a bundled web asset, three Java classes, a slice of the C++ mojo bridge, and the
flag plumbing. Here is who does what.

| File | World | Responsibility |
|---|---|---|
| `chrome/android/java/assets/cromite_automation/harness.html` | JS asset | The harness UI and **all** flow logic: registry, run loop, CRUD, two tabs. |
| `…/headless/CromiteHeadlessBridge.java` | Java | Builds the overlay (`FrameLayout` + `WebView`), attaches it to the tab, toggles visibility. |
| `…/headless/AutomationBridge.java` | Java | The `window.automationNative` surface; marshals JS calls to the UI thread, returns results. |
| `…/headless/AutomationEngine.java` | Java | Implements primitives: locate via JS, then inject real input. |
| `chrome/common/cromite_private_api_extension.mojom` | C++ IDL | Adds `SetContentVisible` / `IsContentVisible` to the existing private API. |
| `chrome/renderer/cromite/cromite_private_api_extension.{cc,h}` | C++ renderer | Exposes those as `window.cromite.*` (external control path). |
| `chrome/browser/cromite/cromite_private_api_host.{cc,h}` | C++ browser | Routes the mojo calls to the Java bridge via JNI. |
| `…/flags/cromite/sHeadlessAutomationMode.java` + `Headless-automation-mode.inc` ×3 | Flag | Defines the `headless-automation-mode` gate. |
| `chrome/android/java/res/xml/developer_preferences.xml` | Settings | The Developer-options switch that turns it on. |

```mermaid
flowchart LR
    subgraph JS["JavaScript (asset)"]
        H["harness.html"]:::js
    end
    subgraph JAVA["Java (chrome/android)"]
        CHB["CromiteHeadlessBridge"]:::java
        AB["AutomationBridge"]:::java
        AE["AutomationEngine"]:::java
    end
    subgraph CPP["C++ (private API)"]
        M["…mojom"]:::cpp
        R["renderer ext"]:::cpp
        HOST["browser host"]:::cpp
    end
    subgraph FLAG["Flag plumbing"]
        INC[".inc × 3"]:::flag
        SF["sHeadlessAutomationMode"]:::flag
        PREF["developer_preferences.xml"]:::flag
    end

    H <--> AB
    CHB --> AB --> AE
    CHB -. hosts .-> H
    R --> M --> HOST --> CHB
    INC --> SF --> CHB
    PREF --> SF

    classDef js fill:#FFE9B8,stroke:#C8901A,color:#5A3E00;
    classDef java fill:#CFE4FF,stroke:#2E6BB8,color:#0A2A4D;
    classDef cpp fill:#CFEFD6,stroke:#2E9E54,color:#0C3D1E;
    classDef flag fill:#EAD9FF,stroke:#7B43C8,color:#33145E;
```

**Takeaway:** the JavaScript talks to exactly one Java object (`AutomationBridge`); the C++
mojo path is a *second*, optional door to the same overlay. The flag plumbing is orthogonal
— it only decides whether any of this is active.

---

## Chapter 2 · Foundation — How a Cromite Flag Comes to Life

Before the harness can exist, a switch must turn it on. Cromite doesn't edit Chromium's giant
`content_features.cc` directly; it drops small `.inc` fragments that the build aggregates. Our
feature, `headless-automation-mode`, is three such fragments plus a Java mirror and a settings
toggle.

The journey of one flag:

```mermaid
flowchart TB
    subgraph Define["1 · Native definition (cromite_flags/…)"]
        H[".../content_features_h/*.inc<br/>BASE_DECLARE_FEATURE(kHeadlessAutomationMode)"]:::flag
        C[".../content_features_cc/*.inc<br/>CROMITE_FEATURE(k…, &quot;HeadlessAutomationMode&quot;, DISABLED)"]:::flag
        A[".../about_flags_cc/*.inc<br/>chrome://flags row · FEATURE_VALUE_TYPE"]:::flag
    end
    GN["cromite_flags/BUILD.gn<br/><i>cpp_bromite_include aggregates the .inc files</i>"]:::cpp
    Feat["base::Feature kHeadlessAutomationMode"]:::cpp

    subgraph JavaSide["2 · Java mirror"]
        CF["sHeadlessAutomationMode<br/>new CachedFlag(ChromeFeatureMap, &quot;HeadlessAutomationMode&quot;, false)"]:::java
    end
    subgraph UI["3 · User control"]
        Pref["developer_preferences.xml<br/>app:featureName=&quot;headless-automation-mode&quot;<br/>app:needRestart=&quot;true&quot;"]:::java
        Native["CromiteNativeUtils (JNI)<br/><i>persists name@1 when enabled</i>"]:::java
    end

    H --> GN
    C --> GN
    A --> GN
    GN --> Feat
    Feat -.->|"matched by name string"| CF
    Pref -->|toggle| Native -->|"name@1 pref"| Feat
    CF -->|".getInstance().isEnabled()"| CHB["CromiteHeadlessBridge.isHeadlessModeEnabled()"]:::java

    classDef flag fill:#EAD9FF,stroke:#7B43C8,color:#33145E;
    classDef cpp fill:#CFEFD6,stroke:#2E9E54,color:#0C3D1E;
    classDef java fill:#CFE4FF,stroke:#2E6BB8,color:#0A2A4D;
```

The string `"HeadlessAutomationMode"` is the glue: it is the `base::Feature` name in C++ **and**
the key the Java `CachedFlag` looks up through `ChromeFeatureMap`. When you flip the Developer-
options switch, `ChromeBaseSettingsFragment` reads `app:featureName`, calls `CromiteNativeUtils`,
and the native side records `headless-automation-mode@1` in flag storage when enabled (and clears
it when disabled). Because the value is *cached* at startup, the toggle is marked
`needRestart="true"`.

**Takeaway:** the harness is dormant until this flag is on; everything downstream reads it through
`sHeadlessAutomationMode.getInstance().isEnabled()`.

---

## Chapter 3 · Foundation — The `window.cromite` Bridge It Extends

The harness did not invent its native bridge. Cromite already ships a **test-support private API**
called `window.cromite`, used by WebDriver/Appium. It is a mojo interface,
`chrome::mojom::CromitePrivateApiExtension`, and the harness simply adds two methods to it:
`SetContentVisible` and `IsContentVisible`.

Two properties of this pre-existing API matter:

1. **It is locked down.** The renderer only injects `window.cromite` when
   `ShouldExposeCromitePrivateApi` is true — that means the `enable-cromite-test-support` feature
   is on **and** the document's origin is exactly `chrome://version`. Ordinary web pages never see it.
2. **It already solved async.** Methods that return a value hand JavaScript a `Promise`, parked in a
   `PendingRequest` map keyed by a `base::UnguessableToken`, and resolved when the browser replies.
   (The harness reuses this exact shape for `IsContentVisible`.)

```mermaid
sequenceDiagram
    participant JS as JS on chrome://version
    participant Ext as CromitePrivateApiExtension<br/>(renderer)
    participant Mojo as AssociatedRemote
    participant Host as CromitePrivateApiHost<br/>(browser · DocumentUserData)

    JS->>Ext: window.cromite.isContentVisible()
    Note over Ext: ShouldExposeCromitePrivateApi?<br/>feature on AND origin == chrome://version
    Ext->>Ext: create Promise + UnguessableToken<br/>store in PendingRequest map
    Ext->>Mojo: IsContentVisible() callback
    Mojo->>Host: routed to bound receiver
    Host-->>Ext: (bool visible)
    Ext->>Ext: look up token → resolve Promise
    Ext-->>JS: Promise resolves(visible)
```

The browser host (`CromitePrivateApiHost`) is a `DocumentUserData` bound through the associated-
interface registry (`BindHost`), so it lives and dies with the frame.

Separately, test-support also reroutes the **DevTools socket**: when `sActAsWebView` is enabled,
`ProcessInitializationHandler` gives the `DevToolsServer` a `weblayer` prefix so Appium can attach.

**Takeaway:** the harness's external control path is a thin extension of an existing, origin-gated,
Promise-capable bridge — not new machinery.

---

## Chapter 4 · Foundation — Where a Page Lives on Android

To lay a UI *over* the page, you need the Android view that *is* the page. On Android, a tab's
`WebContents` exposes a `ViewAndroidDelegate`, and its `getContainerView()` returns the container
`ViewGroup`. In Chrome that container is a `CompositorViewHolder`, which **extends `FrameLayout`** —
a happy fact, because a `FrameLayout` stacks its children, so an overlay added last sits on top
while the compositor surface keeps rendering underneath.

```mermaid
flowchart TB
    WC["WebContents"]:::cpp
    VAD["ViewAndroidDelegate"]:::java
    CVH["CompositorViewHolder<br/><i>(extends FrameLayout)</i>"]:::java
    Surf["Compositor surface<br/><i>the live page pixels</i>"]:::renderer
    Overlay["HarnessOverlay (added on top)"]:::java

    WC -->|getViewAndroidDelegate| VAD -->|getContainerView| CVH
    CVH --> Surf
    CVH -->|addView MATCH_PARENT| Overlay

    classDef cpp fill:#CFEFD6,stroke:#2E9E54,color:#0C3D1E;
    classDef java fill:#CFE4FF,stroke:#2E6BB8,color:#0A2A4D;
    classDef renderer fill:#E5E5EA,stroke:#888,color:#333;
```

From this same `WebContents` the engine borrows three faculties:

- **Read the DOM** — `evaluateJavaScript(String, JavaScriptCallback)`, whose
  `handleJavaScriptResult(String json)` delivers the answer.
- **Navigate** — `getNavigationController().loadUrl(new LoadUrlParams(url))`.
- **Act like a finger/keyboard** — dispatch `MotionEvent` / `KeyEvent` to the container view
  (trusted input), turning characters into keystrokes with
  `KeyCharacterMap.load(VIRTUAL_KEYBOARD)`. (An `EventForwarder` path exists as a version-specific
  alternative; see the appendix.)

**Takeaway:** because the container is a `FrameLayout`, "hiding the page" is just toggling an
overlay child's visibility — the renderer never stops.

---

## Chapter 5 · The Object Model

With the foundations in place, here is the harness proper. Three Java classes and three JavaScript
singletons, related as follows.

```mermaid
classDiagram
    class CromiteHeadlessBridge {
        +setContentVisible(WebContents, boolean)$ «CalledByNative»
        +isContentVisible(WebContents) boolean$ «CalledByNative»
        +isHeadlessModeEnabled() boolean$ «CalledByNative»
        +attachHarness(WebContents)$
        -applyVisibility(WebContents, boolean)$
        -findOverlay(WebContents)$
        -getContainer(WebContents)$
    }
    class HarnessOverlay {
        <<FrameLayout>>
        +WebView webView
        +AutomationBridge bridge
    }
    class AutomationBridge {
        -View mOverlay
        -WebView mHarnessWebView
        -WebContents mTab
        -AutomationEngine mEngine
        +showBrowser() «JavascriptInterface»
        +hideBrowser() «JavascriptInterface»
        +navigate(url, id) «JavascriptInterface»
        +waitForSelector(sel, timeout, id) «JavascriptInterface»
        +evaluate(js, id) «JavascriptInterface»
        +tap(sel, id) «JavascriptInterface»
        +type(sel, text, id) «JavascriptInterface»
        +scrollTo(sel, id) «JavascriptInterface»
        +sleep(ms, id) «JavascriptInterface»
        +cancel() «JavascriptInterface»
        -resolveRaw(id, json)
        -emit(event, payload)
    }
    class AutomationEngine {
        -WebContents mTab
        +navigate(url, BoolCallback)
        +evaluate(js, RawCallback)
        +waitForSelector(sel, timeout, BoolCallback)
        +tap(sel, BoolCallback)
        +type(sel, text, BoolCallback)
        -locateCenter(sel, LocateCallback)
        -dispatchTap(x, y)
        -typeNext(text, i, BoolCallback)
    }
    class BoolCallback { <<interface>> }
    class RawCallback { <<interface>> }

    class window_automationNative { <<JS · injected>> }
    class window_automation { <<JS>> }
    class window_Flows { <<JS>> }

    CromiteHeadlessBridge *-- HarnessOverlay : creates
    HarnessOverlay *-- AutomationBridge : owns
    AutomationBridge --> AutomationEngine : delegates
    AutomationEngine ..> BoolCallback
    AutomationEngine ..> RawCallback
    HarnessOverlay ..> window_automationNative : addJavascriptInterface
    window_automationNative ..> AutomationBridge : is
    window_automation --> window_automationNative : wraps as Promises
    window_Flows --> window_automation : flows call
```

**Takeaway:** `AutomationBridge` is the *seam*. On its JavaScript face it is
`window.automationNative`; on its Java face it delegates the real work to `AutomationEngine`.

---

## Chapter 6 · A Tap, End to End

Nothing illuminates an architecture like following one request all the way down and back. Let's
trace `automation.tap("#login")`.

```mermaid
sequenceDiagram
    participant Flow as harness.html (flow)
    participant API as window.automation
    participant Nat as automationNative (AutomationBridge)
    participant Eng as AutomationEngine
    participant Tab as Tab WebContents
    participant View as Container view

    Flow->>API: await tap("#login")
    API->>API: id = nextId++, pending[id] = resolve
    API->>Nat: tap("#login", id) — on binder thread
    Nat->>Nat: ThreadUtils.runOnUiThread(…)
    Nat->>Eng: tap("#login", cb)
    Eng->>Tab: evaluateJavaScript(getBoundingClientRect + innerW/H)
    Tab-->>Eng: {x, y, iw, ih}  (handleJavaScriptResult)
    Eng->>Eng: scale to container px + jitter
    Eng->>View: MotionEvent ACTION_DOWN
    Eng->>View: MotionEvent ACTION_UP (after dwell)
    Eng-->>Nat: cb.run(true)
    Nat->>Flow: evaluateJavascript("__automationResolve(id, true)")
    Flow->>API: pending[id](true)
    API-->>Flow: Promise resolves → tap done
```

Two details are worth dwelling on. First, the **locate/act split**: JavaScript only computes
*where* the element is (`getBoundingClientRect`); the click itself is a real `MotionEvent` at that
spot, so the renderer records a trusted tap. Second, the **thread hop**: `@JavascriptInterface`
methods arrive on a WebView binder thread, so the bridge immediately bounces to the UI thread
before touching views or `WebContents`.

**Takeaway:** a primitive is a round trip — JS asks, native acts, native calls back into JS by id.

---

## Chapter 7 · Typing Like a Human

Typing is the same locate/act split, stretched over time. The engine first focuses the field via
JavaScript, then emits one character at a time as real key events, pausing between them.

```mermaid
sequenceDiagram
    participant API as window.automation
    participant Eng as AutomationEngine
    participant Tab as Tab WebContents
    participant View as Container view

    API->>Eng: type("#user", "alice", cb)
    Eng->>Tab: evaluateJavaScript(querySelector(...).focus())
    Tab-->>Eng: true
    loop each character
        Eng->>Eng: KEY_MAP.getEvents(ch) via KeyCharacterMap
        Eng->>View: dispatchKeyEvent(KeyEvent…)
        Eng->>Eng: postDelayed(60–180ms, +occasional pause)
    end
    Eng-->>API: cb.run(true) → resolve
```

The randomized cadence (a 60–180 ms base with the occasional longer pause) is the whole point:
the keystrokes are `isTrusted` and arrive with human-shaped timing rather than in a single
instantaneous burst.

**Takeaway:** "human-like" is implemented as *real events + irregular delays*, not as faked DOM
events.

---

## Chapter 8 · The Correlation Trick

You may have noticed every primitive carries a trailing `id`. That integer is how an inherently
one-way channel (`@JavascriptInterface` methods return `void`; results come back via
`evaluateJavascript`) is turned into request/response.

```mermaid
sequenceDiagram
    participant Flow
    participant API as window.automation (call)
    participant Nat as automationNative

    Flow->>API: call("tap", ["#x"])
    API->>API: id = nextId++<br/>pending[id] = resolve
    API->>Nat: automationNative.tap("#x", id)
    Note over Nat: …work happens off-screen…
    Nat-->>API: __automationResolve(id, result)
    API->>API: r = pending[id], delete it, call r(result)
    API-->>Flow: Promise(id) resolves
```

It is deliberately humble: a monotonically increasing counter, a `pending{}` map, and one global
function `window.__automationResolve(id, value)` that the native side calls. The same pattern is a
miniature of the C++ side's `UnguessableToken` map from Chapter 3 — though here, inside a single
trusted page, a plain counter suffices.

**Takeaway:** the `id` is the request ticket; `__automationResolve` is the counter that calls your
number.

---

## Chapter 9 · Two Faces — Harness vs. Browser

The overlay is opaque, so at any instant the user is looking at **either** the harness **or** the
live page. Switching between them is just the overlay's visibility.

```mermaid
stateDiagram-v2
    [*] --> HarnessShown : startup (flag on)<br/>attachHarness → applyVisibility(false)
    HarnessShown --> BrowserShown : showBrowser() / setContentVisible(true)
    BrowserShown --> HarnessShown : hideBrowser() / setContentVisible(false)
    HarnessShown --> HarnessShown : automation runs (page hidden, renderer alive)
    note right of BrowserShown
      Overlay GONE.
      User watches the real page —
      e.g. to finish a step by hand.
    end note
    note left of HarnessShown
      Overlay VISIBLE + bringToFront.
      Chat / Flows UI on screen.
    end note
```

Both faces are reachable two ways: from the page itself (`window.automation.showBrowser()` — the
harness's "Show browser" button) and from outside (`window.cromite.setContentVisible(true)` over
DevTools). They converge on the same `applyVisibility` method.

**Takeaway:** there is exactly one piece of visibility state — the overlay's `VISIBLE`/`GONE` —
and several buttons that flip it.

---

## Chapter 10 · Birth of the Overlay

How does the harness get on screen in the first place? When the flag is on, the tab-init path calls
`CromiteHeadlessBridge.attachHarness(webContents)`. (Wiring this call into the active-tab/activity
init is one of the build-environment integration points — see the appendix.)

```mermaid
sequenceDiagram
    participant Init as Tab/Activity init
    participant CHB as CromiteHeadlessBridge
    participant Cont as Container (CompositorViewHolder)
    participant Ov as HarnessOverlay (FrameLayout)
    participant WV as WebView
    participant AB as AutomationBridge

    Init->>CHB: attachHarness(webContents)
    CHB->>CHB: isHeadlessModeEnabled()? ✔
    CHB->>CHB: applyVisibility(webContents, false)
    CHB->>Cont: getContainer() via ViewAndroidDelegate
    CHB->>Ov: new HarnessOverlay(webContents)
    Ov->>WV: new WebView (JS + DOM storage + file access)
    Ov->>AB: new AutomationBridge(overlay, webView, tab)
    Ov->>WV: addJavascriptInterface(bridge, "automationNative")
    Ov->>WV: loadUrl("file:///android_asset/cromite_automation/harness.html")
    CHB->>Cont: addView(overlay, MATCH_PARENT)
    CHB->>Ov: setVisibility(VISIBLE) + bringToFront()
```

**Takeaway:** attachment is idempotent and lazy — `findOverlay` ensures one overlay per
`WebContents`, created the first time the page is hidden.

---

## Chapter 11 · The External Door

For completeness: the C++ `window.cromite` methods added in Chapter 3 exist so an *external*
controller (WebDriver/Appium on a desktop) can drive the same show/hide as the in-page buttons.
This chapter just shows the new tail of that journey, where C++ reaches Java.

```mermaid
sequenceDiagram
    participant JS as window.cromite (chrome://version)
    participant Host as CromitePrivateApiHost (browser)
    participant JNI as Java_CromiteHeadlessBridge_*
    participant CHB as CromiteHeadlessBridge

    JS->>Host: setContentVisible(false) — via renderer + mojo (Ch.3)
    Host->>JNI: SetContentVisible(java WebContents, false)
    JNI->>CHB: setContentVisible(WebContents, false)
    CHB->>CHB: ThreadUtils.runOnUiThread(applyVisibility(…, false))
```

**Takeaway:** the external door and the in-page buttons are two entrances to one room —
`applyVisibility`.

---

## Chapter 12 · Flows Live in JavaScript

Finally, the brain. Everything about *what to automate* is JavaScript inside `harness.html`; no
native change is needed to add or edit a flow. A flow is just an object with an async `run(a)` that
calls the `window.automation` primitives.

```mermaid
flowchart TB
    subgraph UI["harness.html · two tabs"]
        Chat["Chat tab<br/><i>UI only (no chat yet)</i>"]:::js
        FlowsTab["Flows tab<br/><i>list + (+) button</i>"]:::js
    end
    Registry["window.Flows<br/>list • get • add • update • remove • run"]:::js
    RunLoop["Flows.run(id)<br/><i>await f.run(window.automation)</i>"]:::js
    API["window.automation<br/>navigate • waitFor • tap • type • …"]:::js
    Plus(["+ button → no-op for now"]):::muted

    FlowsTab -->|tap a flow| RunLoop
    FlowsTab --> Plus
    Registry --> RunLoop --> API
    API -->|status / failure| FlowsTab

    classDef js fill:#FFE9B8,stroke:#C8901A,color:#5A3E00;
    classDef muted fill:#F0F0F0,stroke:#AAA,color:#777;
```

The **Chat** tab is intentionally inert UI (no real chatting yet). The **Flows** tab lists whatever
`window.Flows` holds; tapping one runs it, and the engine's `onStatus`/`onProgress`/`onFailure`
events feed the status line and the "do it manually" prompt. The **(+)** button is a deliberate
placeholder — flow *creation through the harness* isn't designed yet, so it does nothing but say so.

**Takeaway:** to ship a new automation you write a JS object and `window.Flows.add(...)` it; the
native layer never changes.

---

## Appendix A · Primitive Reference

| `window.automation` | Native (`automationNative`) | Engine action |
|---|---|---|
| `navigate(url)` | `navigate(url, id)` | `getNavigationController().loadUrl(LoadUrlParams)` |
| `waitFor(sel, timeout)` | `waitForSelector(sel, timeout, id)` | poll `querySelector` via `evaluateJavaScript` |
| `evaluate(js)` | `evaluate(js, id)` | `evaluateJavaScript(js, JavaScriptCallback)` |
| `tap(sel)` | `tap(sel, id)` | `locateCenter` → `dispatchTap` (`MotionEvent` down/up + jitter) |
| `type(sel, text)` | `type(sel, text, id)` | focus via JS → `typeNext` (`KeyEvent` per char + delay) |
| `scrollTo(sel)` | `scrollTo(sel, id)` | `element.scrollIntoView` via JS |
| `sleep(ms)` | `sleep(ms, id)` | `WebView.postDelayed` |
| `showBrowser()` / `hideBrowser()` | same | overlay `setVisibility(GONE / VISIBLE)` |
| `cancel()` | `cancel()` | stop pending posts, clear handler |

Engine → harness events: `onStatus({text})`, `onProgress({step,total})`, `onFailure({message})`,
delivered by `AutomationBridge.emit(...)` → `window.automation.<event>(...)`.

## Appendix B · Threading Model

- `@JavascriptInterface` methods run on a **WebView binder thread**. `AutomationBridge` immediately
  marshals to the **UI thread** with `ThreadUtils.runOnUiThread` before touching any `View` or
  `WebContents`.
- Results return to JavaScript on the UI thread via `WebView.evaluateJavascript(...)`.
- Per-character typing and the tap's up-event use `Handler.postDelayed` on the main looper, so the
  UI thread is never blocked while "waiting like a human".

## Appendix C · Build-Environment Integration Checklist

These are intentionally **not** in the patch diff (they are Chromium-version/tree specific, mirroring
the patch's existing `generate_jni` note):

1. **`generate_jni`** — register `CromiteHeadlessBridge`, `AutomationBridge`, `AutomationEngine` so
   `CromiteHeadlessBridge_jni.h` is generated for `chrome/browser`.
2. **`android_assets()`** — bundle `harness.html` to
   `assets/cromite_automation/harness.html` (mirror `Experimental-user-scripts-support.patch`).
3. **Startup call site** — invoke `CromiteHeadlessBridge.attachHarness(tab.getWebContents())` at
   active-tab/activity init, re-asserting on active-tab change so a new tab can't leak content.
4. **Input dispatch** — confirm container `dispatchTouchEvent`/`dispatchKeyEvent` versus
   `WebContents.getEventForwarder()` for the targeted Chromium version.

---

*This document is hand-maintained. The patch itself is `build/patches/Add-headless-automation-mode.patch`;
the auto-generated catalogue entry lives in `docs/PATCHES.md`.*
