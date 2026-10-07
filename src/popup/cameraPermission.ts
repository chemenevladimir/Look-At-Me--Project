export interface CameraPermissionDiagnostics {
  context: 'visible-extension-page';
  origin: string;
  secureContext: boolean;
  userActivationActive: boolean;
  permissionState: PermissionState | 'unsupported' | 'unknown';
  videoInputCount: number | 'unknown';
}

export const readCameraPermissionState = async (): Promise<CameraPermissionDiagnostics['permissionState']> => {
  if (!navigator.permissions?.query) return 'unsupported';
  try {
    const result = await navigator.permissions.query({ name: 'camera' as PermissionName });
    return result.state;
  } catch {
    return 'unknown';
  }
};

const readVideoInputCount = async (): Promise<number | 'unknown'> => {
  if (!navigator.mediaDevices?.enumerateDevices) return 'unknown';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput').length;
  } catch {
    return 'unknown';
  }
};

export const collectCameraPermissionDiagnostics = async (): Promise<CameraPermissionDiagnostics> => ({
  context: 'visible-extension-page',
  origin: location.origin,
  secureContext: window.isSecureContext,
  userActivationActive: navigator.userActivation?.isActive ?? false,
  permissionState: await readCameraPermissionState(),
  videoInputCount: await readVideoInputCount(),
});

export const ensureCameraPermissionFromVisiblePage = async (): Promise<CameraPermissionDiagnostics> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API is unavailable in the visible extension permission page.');
  }

  // This call deliberately happens directly inside the visible permission-page button handler.
  // A hidden MV3 offscreen document can keep an already-authorized stream, but
  // is not a reliable place to initiate Chrome's first camera permission prompt.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' },
      audio: false,
    });
    stream.getTracks().forEach((track) => track.stop());
    const diagnostics = await collectCameraPermissionDiagnostics();
    console.info('[Look At Me] Camera permission bootstrap succeeded.', diagnostics);
    return diagnostics;
  } catch (cause) {
    const diagnostics = await collectCameraPermissionDiagnostics();
    const name = cause instanceof DOMException || cause instanceof Error ? cause.name : 'UnknownError';
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error('[Look At Me] Camera permission bootstrap failed.', { name, message, ...diagnostics, cause });
    throw new Error(
      `Camera access failed in visible extension permission page: ${name}: ${message || 'No browser error message.'} `
      + `(permission=${diagnostics.permissionState}, videoInputs=${diagnostics.videoInputCount}, `
      + `secureContext=${diagnostics.secureContext}, userActivation=${diagnostics.userActivationActive}).`,
    );
  }
};
