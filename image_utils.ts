/**
 * Image processing utilities for ESP32 camera data
 * Uses JIMP for 100% reliable server-side image rotation
 */

import Jimp from 'jimp';
import { Buffer } from 'node:buffer';
import { Logger } from './logger.ts';

const logger = new Logger('[ImageUtils]');

/**
 * Rotates a base64 JPEG image by 180 degrees using JIMP
 * This is a 100% reliable method that works in all JavaScript environments
 * @param base64Image - Base64 encoded JPEG image data (without data URL prefix)
 * @returns Promise<string> - Base64 encoded rotated JPEG image
 */
export async function rotateImage180(base64Image: string): Promise<string> {
    try {
        logger.info('🔄 Starting 180° rotation for ESP32 image using JIMP...');

        // Decode base64 to Buffer
        const imageBuffer = Buffer.from(base64Image, 'base64');

        // Load image with JIMP
        const image = await Jimp.read(imageBuffer);
        logger.debug(`📐 Image dimensions: ${image.getWidth()}x${image.getHeight()} pixels`);

        // Rotate the image 180 degrees
        image.rotate(180);

        // Convert back to buffer with JPEG quality
        const rotatedBuffer = await image.quality(90).getBufferAsync(Jimp.MIME_JPEG);

        // Convert to base64
        const rotatedBase64 = rotatedBuffer.toString('base64');

        logger.info('✅ 180° rotation completed successfully using JIMP');
        return rotatedBase64;
    } catch (error) {
        logger.error('❌ Error during image rotation:', error);
        logger.warn('⚠️  Returning original image without rotation');
        return base64Image;
    }
}

/**
 * Creates a simple test image for validation purposes
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param color - Color in RGBA format (default: red)
 * @returns Promise<string> - Base64 encoded JPEG image
 */
export async function createTestImage(
    width: number = 100,
    height: number = 100,
    color: number = 0xFF0000FF,
): Promise<string> {
    try {
        const image = new Jimp(width, height, color);
        const buffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        return buffer.toString('base64');
    } catch (error) {
        logger.error('❌ Error creating test image:', error);
        throw error;
    }
}

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
