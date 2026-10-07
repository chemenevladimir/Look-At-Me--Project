import type { CameraEvidenceFrame } from '../proctoring/ProctoringEngine';

export interface EvidenceLayout {
  canvasWidth: number;
  canvasHeight: number;
  cameraX: number;
  cameraY: number;
  cameraWidth: number;
  cameraHeight: number;
  labelHeight: number;
}

export const calculateEvidenceLayout = (
  pageWidth: number,
  pageHeight: number,
  cameraWidth: number,
  cameraHeight: number,
): EvidenceLayout => {
  const outputScale = Math.min(1, 1600 / Math.max(1, pageWidth));
  const canvasWidth = Math.max(1, Math.round(pageWidth * outputScale));
  const canvasHeight = Math.max(1, Math.round(pageHeight * outputScale));
  const margin = Math.max(12, Math.round(canvasWidth * 0.02));
  const insetWidth = Math.min(420, Math.max(220, Math.round(canvasWidth * 0.31)));
  const safeCameraRatio = Math.max(0.5, Math.min(2.5, cameraWidth / Math.max(1, cameraHeight)));
  const insetImageHeight = Math.round(insetWidth / safeCameraRatio);
  const labelHeight = Math.min(Math.max(1, Math.round(canvasHeight * 0.2)), Math.max(24, Math.round(insetWidth * 0.09)));
  const cameraHeightWithLabel = insetImageHeight + labelHeight;
  const finalCameraWidth = Math.max(1, Math.min(insetWidth, canvasWidth - margin * 2));
  const finalCameraHeight = Math.max(1, Math.min(insetImageHeight, canvasHeight - labelHeight - margin * 2));
  return {
    canvasWidth,
    canvasHeight,
    cameraX: Math.max(margin, canvasWidth - insetWidth - margin),
    cameraY: Math.max(margin, canvasHeight - cameraHeightWithLabel - margin),
    cameraWidth: finalCameraWidth,
    cameraHeight: finalCameraHeight,
    labelHeight,
  };
};

const decodePng = async (frame: CameraEvidenceFrame): Promise<ImageBitmap> => {
  if (frame.mimeType !== 'image/png') throw new Error('Evidence composition accepts PNG frames only.');
  const bytes = Uint8Array.from(atob(frame.data), (character) => character.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
};

const safeLabel = (eventType: string): string =>
  eventType.replace(/[^A-Z0-9_]/gi, '').replace(/_/g, ' ').slice(0, 42) || 'VIOLATION';

export const composeEvidencePng = async (
  pageFrame: CameraEvidenceFrame,
  cameraFrame: CameraEvidenceFrame,
  eventType: string,
  timestamp: number,
  options: { final?: boolean; score?: number; status?: string } = {},
): Promise<CameraEvidenceFrame> => {
  const [page, camera] = await Promise.all([decodePng(pageFrame), decodePng(cameraFrame)]);
  try {
    const layout = calculateEvidenceLayout(page.width, page.height, camera.width, camera.height);
    const canvas = document.createElement('canvas');
    canvas.width = layout.canvasWidth;
    canvas.height = layout.canvasHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable for evidence composition.');

    context.drawImage(page, 0, 0, layout.canvasWidth, layout.canvasHeight);

    if (options.final) {
      const bannerHeight = Math.max(48, Math.round(layout.canvasHeight * 0.085));
      context.fillStyle = 'rgba(7,17,31,.94)';
      context.fillRect(0, 0, layout.canvasWidth, bannerHeight);
      context.fillStyle = '#6ee7b7';
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.font = `800 ${Math.max(18, Math.round(bannerHeight * 0.38))}px system-ui, sans-serif`;
      context.fillText('LOOK AT ME! · FINAL SCREENSHOT', Math.round(bannerHeight * 0.35), bannerHeight / 2);
      context.fillStyle = '#e2e8f0';
      context.textAlign = 'right';
      context.font = `600 ${Math.max(12, Math.round(bannerHeight * 0.25))}px system-ui, sans-serif`;
      const status = (options.status || 'COMPLETED').replace(/[^A-Z0-9 _-]/gi, '').slice(0, 30);
      const score = Math.min(200, Math.max(0, Math.round(options.score || 0)));
      context.fillText(`${status} · SCORE ${score}/200 · ${new Date(timestamp).toLocaleString()}`,
        layout.canvasWidth - Math.round(bannerHeight * 0.35), bannerHeight / 2);
    }

    const border = Math.max(3, Math.round(layout.cameraWidth * 0.012));
    const labelY = layout.cameraY + layout.cameraHeight;
    context.save();
    context.shadowColor = 'rgba(0,0,0,.48)';
    context.shadowBlur = Math.max(12, Math.round(layout.cameraWidth * 0.06));
    context.fillStyle = '#07111f';
    context.fillRect(
      layout.cameraX - border,
      layout.cameraY - border,
      layout.cameraWidth + border * 2,
      layout.cameraHeight + layout.labelHeight + border * 2,
    );
    context.restore();

    context.save();
    context.beginPath();
    context.rect(layout.cameraX, layout.cameraY, layout.cameraWidth, layout.cameraHeight);
    context.clip();
    context.translate(layout.cameraX + layout.cameraWidth, layout.cameraY);
    context.scale(-1, 1);
    context.drawImage(camera, 0, 0, layout.cameraWidth, layout.cameraHeight);
    context.restore();

    context.fillStyle = 'rgba(7,17,31,.96)';
    context.fillRect(layout.cameraX, labelY, layout.cameraWidth, layout.labelHeight);
    context.fillStyle = '#6ee7b7';
    context.font = `700 ${Math.max(10, Math.round(layout.labelHeight * 0.43))}px system-ui, sans-serif`;
    context.textBaseline = 'middle';
    context.fillText(
      `CAMERA · ${safeLabel(eventType)}`,
      layout.cameraX + Math.max(8, Math.round(layout.cameraWidth * 0.035)),
      labelY + layout.labelHeight / 2,
      layout.cameraWidth * 0.72,
    );
    context.fillStyle = '#cbd5e1';
    context.textAlign = 'right';
    context.font = `500 ${Math.max(9, Math.round(layout.labelHeight * 0.36))}px system-ui, sans-serif`;
    context.fillText(
      new Date(timestamp).toLocaleTimeString(),
      layout.cameraX + layout.cameraWidth - Math.max(8, Math.round(layout.cameraWidth * 0.035)),
      labelY + layout.labelHeight / 2,
      layout.cameraWidth * 0.25,
    );

    const url = canvas.toDataURL('image/png');
    return {
      data: url.slice(url.indexOf(',') + 1),
      mimeType: 'image/png',
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    page.close();
    camera.close();
  }
};
