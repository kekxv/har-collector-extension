// src/__tests__/streaming-har.test.ts

import { estimateChunkCount, generateChunkFilename } from '../lib/streaming-har.js';

describe('estimateChunkCount', () => {
    it('returns 1 for zero records', () => {
        expect(estimateChunkCount(0)).toBe(1);
    });

    it('returns 1 for small record counts', () => {
        expect(estimateChunkCount(10)).toBe(1);
        expect(estimateChunkCount(100)).toBe(1);
    });

    it('estimates based on 80% filter rate and 500 chunk size', () => {
        // 500 records * 0.8 = 400 entries, 400/500 = 0.8 → ceil = 1
        expect(estimateChunkCount(500)).toBe(1);
        // 625 * 0.8 = 500 → exactly 1 chunk
        expect(estimateChunkCount(625)).toBe(1);
        // 626 * 0.8 = 500.8 → ceil(500.8/500) = 2
        expect(estimateChunkCount(626)).toBe(2);
    });

    it('handles large record counts', () => {
        expect(estimateChunkCount(10000)).toBe(16); // 10000*0.8=8000, 8000/500=16
        expect(estimateChunkCount(50000)).toBe(80);
    });

    it('respects custom chunk size', () => {
        expect(estimateChunkCount(1000, 100)).toBe(8); // 1000*0.8=800, 800/100=8
    });
});

describe('generateChunkFilename', () => {
    it('returns original name for single chunk', () => {
        expect(generateChunkFilename('capture.har', 1, 1)).toBe('capture.har');
    });

    it('appends zero-padded index for multi-chunk', () => {
        expect(generateChunkFilename('capture.har', 1, 3)).toBe('capture-001.har');
        expect(generateChunkFilename('capture.har', 10, 20)).toBe('capture-010.har');
        expect(generateChunkFilename('capture.har', 100, 200)).toBe('capture-100.har');
    });

    it('handles filenames without extension', () => {
        expect(generateChunkFilename('capture', 1, 2)).toBe('capture-001');
    });

    it('handles multiple dots in filename', () => {
        expect(generateChunkFilename('my.capture.har', 1, 2)).toBe('my.capture-001.har');
    });
});
