/**
 * Agent Unit Tests
 * Tests for the 4-agent AI pipeline
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Mock logger
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }
}));

// Mock ML client
const mockCallMLService = jest.fn();
const mockCheckMLServiceHealth = jest.fn();
jest.unstable_mockModule('../../../src/ml/ml-client.js', () => ({
    callMLService: mockCallMLService,
    checkMLServiceHealth: mockCheckMLServiceHealth,
}));

// Mock ML config
jest.unstable_mockModule('../../../src/config/ml.config.js', () => ({
    isMLServiceEnabled: jest.fn(() => true),
    getHealthCheckUrl: jest.fn(),
    getInferenceUrl: jest.fn(),
    getMLConfig: jest.fn(() => ({ enabled: true })),
    default: { enabled: true },
}));

const { detectDeepfake, aggregatePredictions } = await import('../../../src/agents/detection.agent.js');
const { callMLService, checkMLServiceHealth } = await import('../../../src/ml/ml-client.js');

describe('Detection Agent', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('aggregatePredictions', () => {
        test('should aggregate single prediction correctly', () => {
            const predictions = [{
                riskScore: 75,
                confidence: 90,
                videoScore: 70,
                audioScore: 0,
                ganFingerprint: 75,
                temporalConsistency: 100,
                modelVersion: 'v1'
            }];

            const result = aggregatePredictions(predictions);

            expect(result.riskScore).toBe(75);
            expect(result.confidence).toBe(90);
            expect(result.frameCount).toBe(1);
            expect(result.variance).toBe(0);
            expect(result.uncertainty).toBe(0);
        });

        test('should aggregate multiple predictions with weighted average', () => {
            const predictions = [
                { riskScore: 80, confidence: 95, videoScore: 75, audioScore: 0, ganFingerprint: 80, temporalConsistency: 100, modelVersion: 'v1' },
                { riskScore: 60, confidence: 85, videoScore: 55, audioScore: 0, ganFingerprint: 60, temporalConsistency: 100, modelVersion: 'v1' },
                { riskScore: 70, confidence: 90, videoScore: 65, audioScore: 0, ganFingerprint: 70, temporalConsistency: 100, modelVersion: 'v1' }
            ];

            const result = aggregatePredictions(predictions);

            expect(result.frameCount).toBe(3);
            expect(result.riskScore).toBeGreaterThan(60);
            expect(result.riskScore).toBeLessThan(80);
            expect(result.variance).toBeGreaterThan(0);
        });

        test('should throw error for empty predictions', () => {
            expect(() => aggregatePredictions([])).toThrow('No predictions to aggregate');
        });
    });

    describe('detectDeepfake', () => {
        test('should call ML service and return results', async () => {
            const mockPerceptionData = {
                hash: 'test-hash',
                mediaType: 'VIDEO',
                extractedFrames: ['/path/to/frame1.jpg', '/path/to/frame2.jpg']
            };

            const mockMLResults = {
                riskScore: 75,
                confidence: 90,
                videoScore: 70,
                audioScore: 0,
                ganFingerprint: 75,
                temporalConsistency: 85,
                frameCount: 2,
                variance: 0.05,
                uncertainty: 5,
                modelVersion: 'v1'
            };

            checkMLServiceHealth.mockResolvedValue(true);
            callMLService.mockResolvedValue(mockMLResults);

            const result = await detectDeepfake(mockPerceptionData);

            expect(checkMLServiceHealth).toHaveBeenCalled();
            expect(callMLService).toHaveBeenCalledWith(mockPerceptionData);
            expect(result).toEqual(mockMLResults);
        });

        test('should forward ML progress updates', async () => {
            const mockPerceptionData = {
                hash: 'test-hash',
                mediaType: 'VIDEO',
                extractedFrames: ['/path/to/frame1.jpg']
            };
            const onProgress = jest.fn();
            checkMLServiceHealth.mockResolvedValue(true);
            callMLService.mockImplementation(async (_data, reportProgress) => {
                reportProgress(60, 'Detection Agent - Running ML inference');
                return { riskScore: 50 };
            });

            await detectDeepfake(mockPerceptionData, onProgress);

            expect(callMLService).toHaveBeenCalledWith(mockPerceptionData, onProgress);
            expect(onProgress).toHaveBeenCalledWith(60, 'Detection Agent - Running ML inference');
        });

        test('should throw error if ML service is unhealthy', async () => {
            checkMLServiceHealth.mockResolvedValue(false);

            const mockPerceptionData = {
                hash: 'test-hash',
                mediaType: 'VIDEO',
                extractedFrames: ['/path/to/frame1.jpg']
            };

            await expect(detectDeepfake(mockPerceptionData)).rejects.toThrow('ML service is not healthy');
        });
    });
});
