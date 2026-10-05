interface LocalBrowserMonitorCallbacks {
  onEvent: (event: unknown) => void;
  onFullscreenState: (active: boolean) => void;
}

export function startLocalBrowserMonitor(callbacks: LocalBrowserMonitorCallbacks): () => void {
  const emit = (eventType: string, explanation: string, metadata?: Record<string, string | number | boolean>) => {
    callbacks.onEvent({ eventType, source: 'browser', confidence: 1, explanation, metadata });
  };
  const onBlur = () => emit('WINDOW_BLUR', 'The monitored browser window lost focus.');
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      emit('TAB_SWITCH', 'The monitored page became hidden.');
    }
  };
  const onFullscreen = () => {
    const active = Boolean(document.fullscreenElement);
    callbacks.onFullscreenState(active);
    if (!active) emit('FULLSCREEN_EXIT', 'Full-screen mode was exited during monitoring.');
  };
  const onCopy = () => emit('COPY_ATTEMPT', 'A copy action occurred in the monitored page.');
  const onPaste = () => emit('PASTE_ATTEMPT', 'A paste action occurred in the monitored page.');
  const onContextMenu = () => emit('CONTEXT_MENU', 'The context menu was opened in the monitored page.');
  const onKeyDown = (event: KeyboardEvent) => {
    const devtools = event.key === 'F12' || (event.ctrlKey && event.shiftKey && ['I', 'J', 'C'].includes(event.key.toUpperCase()));
    if (devtools) {
      emit('DEVTOOLS_ATTEMPT', 'A browser developer-tools shortcut was observed.', {
        shortcut: event.key === 'F12' ? 'F12' : `Ctrl+Shift+${event.key.toUpperCase()}`,
      });
    }
  };

  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('copy', onCopy);
  document.addEventListener('paste', onPaste);
  document.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('keydown', onKeyDown, true);

  return () => {
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('fullscreenchange', onFullscreen);
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('paste', onPaste);
    document.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('keydown', onKeyDown, true);
  };
}
