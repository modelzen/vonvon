declare module 'vonvon-native' {
  export type KirbyState =
    | 'floating'
    | 'snapping'
    | 'dockedExpanded'
    | 'dockedCollapsed'

  export type KirbyForm =
    | 'floating'
    | 'snapping'
    | 'dockedExpanded'
    | 'dockedCollapsed'

  export type FeishuBounds = {
    x: number
    y: number
    width: number
    height: number
    windowId: number
    windowTitle?: string
  }

  /** Create the Kirby floating NSPanel at screen position (x, y). */
  export function createKirbyWindow(x: number, y: number): void

  /** Destroy the Kirby NSPanel and stop all monitors. */
  export function destroyKirbyWindow(): void

  /** Returns the current window state. */
  export function getKirbyState(): KirbyState

  /** Load a URL in the embedded WKWebView. */
  export function loadContent(url: string): void

  /** Show/hide the native panel. */
  export function setVisible(visible: boolean): void

  /** Register a callback fired as Kirby approaches Feishu during drag. */
  export function onSnapProximity(callback: (distance: number) => void): void

  /** Register a callback fired when the snap animation completes. Payload
   *  carries Feishu's bounds so JS can position the sidebar BrowserWindow. */
  export function onSnapComplete(callback: (bounds: FeishuBounds) => void): void

  /** Register a callback fired when Kirby is detached back to floating
   *  mode via performDetachAnimation (Feishu disappeared). */
  export function onDetach(callback: () => void): void

  /** Register a callback fired when the user clicks the ball while docked.
   *  In dockedCollapsed, native has already transitioned state to
   *  dockedExpanded and switched the SVG form. In dockedExpanded, JS can
   *  treat the callback as the explicit inspect gesture. */
  export function onDockedClick(callback: (bounds: FeishuBounds) => void): void

  /** Register a callback fired when the user drags the ball past 8px
   *  while docked (tear-off). Native has already transitioned state to
   *  floating and switched the SVG form; JS hides the sidebar. */
  export function onDragLeave(callback: () => void): void

  /** Legacy callback kept for compatibility with older integrations.
   *  Current behavior keeps the sidebar attached while Feishu remains visible. */
  export function onCollapseSidebar(callback: () => void): void

  /** Register a callback fired while the docked ball tracks Feishu so JS can
   *  keep the sidebar aligned and ordered relative to the current Feishu window. */
  export function onFeishuMoved(callback: (bounds: FeishuBounds) => void): void

  /** Trigger the detach animation (docked → floating). */
  export function detachToFloating(): void

  /** JS → Native: force-set the SVG form displayed by the ball. */
  export function setKirbyForm(form: KirbyForm): void

  /** JS → Native: trigger a manifest-driven transition animation on top of
   *  the current form. Used for detach peel-off effects and similar
   *  short-lived motion accents. */
  export function playKirbyTransition(transitionName: 'detach'): void

  /** JS → Native: called when the user closes the sidebar via the ✕
   *  button. Transitions native state dockedExpanded → dockedCollapsed
   *  and switches SVG form. JS is responsible for hiding the BrowserWindow. */
  export function collapseSidebar(): void

  /** Register a callback fired when the user right-clicks the Kirby ball
   *  (only while floating — suppressed in any docked state). */
  export function onRightClick(callback: () => void): void
}
