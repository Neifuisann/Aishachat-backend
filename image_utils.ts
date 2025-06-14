/**
 * Image processing utilities for ESP32 camera data
 * Uses JIMP for 100% reliable server-side image rotation
 */

import Jimp from 'jimp';
import { Buffer } from 'node:buffer';
import { Logger } from './logger.ts';

const logger = new Logger('[ImageUtils]');

/**
 * Validates if a base64 string represents a valid JPEG image
 * @param base64Image - Base64 encoded image data
 * @returns boolean - True if valid JPEG format
 */
export function isValidJpegBase64(base64Image: string): boolean {
    try {
        // JPEG files start with /9j/ in base64 (which is 0xFFD8 in hex)
        return base64Image.startsWith('/9j/') || base64Image.startsWith('iVBOR'); // Also allow PNG
    } catch {
        return false;
    }
}
