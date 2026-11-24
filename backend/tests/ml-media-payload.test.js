import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { getMediaContentType, selectInferenceFrames } from '../src/ml/media-payload.js';

describe('ML media payload helpers', () => {
  test('selects evenly distributed frames without exceeding the inference limit', () => {
    const frames = Array.from({ length: 60 }, (_, index) => `frame-${index}`);
    const selected = selectInferenceFrames(frames, 24);

    expect(selected).toHaveLength(24);
    expect(selected[0]).toBe('frame-0');
    expect(selected.at(-1)).toBe('frame-59');
    expect(new Set(selected).size).toBe(24);
  });

  test('preserves all frames when already under the limit', () => {
    const frames = ['first.jpg', 'last.jpg'];
    expect(selectInferenceFrames(frames, 24)).toEqual(frames);
  });

  test('maps supported image and audio extensions to upload content types', () => {
    expect(getMediaContentType('/tmp/frame.jpeg')).toBe('image/jpeg');
    expect(getMediaContentType('/tmp/audio.wav')).toBe('audio/wav');
    expect(getMediaContentType('/tmp/audio.unknown')).toBe('application/octet-stream');
  });

  test('sends frame and audio bytes to the remote inference service', async () => {
    const previousEnv = {
      enabled: process.env.ML_SERVICE_ENABLED,
      url: process.env.ML_SERVICE_URL,
      maxFrames: process.env.ML_MAX_INFERENCE_FRAMES,
      warmupPollInterval: process.env.ML_MODEL_WARMUP_POLL_INTERVAL,
    };
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-client-test-'));
    const received = [];
    let healthChecks = 0;
    const server = http.createServer(async (request, response) => {
      if (request.url === '/health') {
        healthChecks += 1;
        if (healthChecks === 1) {
          response.writeHead(503);
          response.end('Service is waking');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'healthy', model_status: 'loaded' }));
        return;
      }

      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push({
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('latin1'),
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ risk_score: 78, video_score: 75 }));
    });

    try {
      const framePaths = ['frame-0.jpg', 'frame-1.jpg', 'frame-2.jpg'].map((name, index) => {
        const framePath = path.join(temporaryDirectory, name);
        fs.writeFileSync(framePath, `frame-bytes-${index}`);
        return framePath;
      });
      const audioPath = path.join(temporaryDirectory, 'audio.wav');
      fs.writeFileSync(audioPath, 'audio-bytes');

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      process.env.ML_SERVICE_ENABLED = 'true';
      process.env.ML_SERVICE_URL = `http://127.0.0.1:${address.port}`;
      process.env.ML_MAX_INFERENCE_FRAMES = '2';
      process.env.ML_MODEL_WARMUP_POLL_INTERVAL = '1';

      const { callMLService } = await import('../src/ml/ml-client.js');
      const result = await callMLService({
        hash: 'test-hash',
        mediaType: 'VIDEO',
        extractedFrames: framePaths,
        extractedAudio: audioPath,
      });

      expect(result.riskScore).toBe(78);
      expect(healthChecks).toBe(2);
      expect(received).toHaveLength(1);
      expect(received[0].contentType).toContain('multipart/form-data; boundary=');
      expect(received[0].body).toContain('"mediaType":"VIDEO"');
      expect(received[0].body).toContain('frame-0.jpg');
      expect(received[0].body).toContain('frame-2.jpg');
      expect(received[0].body).not.toContain('frame-1.jpg');
      expect(received[0].body).toContain('frame-bytes-0');
      expect(received[0].body).toContain('frame-bytes-2');
      expect(received[0].body).toContain('audio-bytes');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      if (previousEnv.enabled === undefined) delete process.env.ML_SERVICE_ENABLED;
      else process.env.ML_SERVICE_ENABLED = previousEnv.enabled;
      if (previousEnv.url === undefined) delete process.env.ML_SERVICE_URL;
      else process.env.ML_SERVICE_URL = previousEnv.url;
      if (previousEnv.maxFrames === undefined) delete process.env.ML_MAX_INFERENCE_FRAMES;
      else process.env.ML_MAX_INFERENCE_FRAMES = previousEnv.maxFrames;
      if (previousEnv.warmupPollInterval === undefined) delete process.env.ML_MODEL_WARMUP_POLL_INTERVAL;
      else process.env.ML_MODEL_WARMUP_POLL_INTERVAL = previousEnv.warmupPollInterval;
    }
  });
});
