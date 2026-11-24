const MAX_INFERENCE_FRAMES = 8;

export const selectInferenceFrames = (framePaths, maxFrames = MAX_INFERENCE_FRAMES) => {
  if (!Array.isArray(framePaths) || framePaths.length === 0) return [];
  if (framePaths.length <= maxFrames) return framePaths;
  if (maxFrames <= 1) return [framePaths[0]];

  const lastIndex = framePaths.length - 1;
  return Array.from({ length: maxFrames }, (_, index) =>
    framePaths[Math.round((index * lastIndex) / (maxFrames - 1))]
  );
};

export const getMediaContentType = (filePath) => {
  const extension = filePath.split('.').pop()?.toLowerCase();
  const contentTypes = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
  };
  return contentTypes[extension] || 'application/octet-stream';
};
