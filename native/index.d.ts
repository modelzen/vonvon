declare module 'vonvon-native' {
  export type KirbyState = 'floating' | 'snapping' | 'docked'

  /** Create the Kirby floating NSPanel at screen position (x, y). */
  export function createKirbyWindow(x: number, y: number): void

  /** Destroy the Kirby NSPanel and stop all monitors. */
  export function destroyKirbyWindow(): void

  /** Returns the current window state. */
  export function getKirbyState(): KirbyState

  /** Load a URL in the embedded WKWebView. */
  export function loadContent(url: string): void

  /** Register a callback fired when Kirby enters the Feishu snap zone. */
  export function onSnapProximity(callback: (distance: number) => void): void

  /** Register a callback fired when the snap animation completes. */
  export function onSnapComplete(callback: () => void): void

  /** Register a callback fired when Kirby detaches back to floating mode. */
  export function onDetach(callback: () => void): void

  /** Trigger the detach animation (docked → floating). */
  export function detachToFloating(): void
}
