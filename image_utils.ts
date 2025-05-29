/**
 * Image processing utilities for ESP32 camera data
 * Uses imagescript for actual pixel-level image rotation
 */

import { Image } from "imagescript";

/**
 * Rotates a base64 JPEG image by 180 degrees using pixel-level manipulation
 * @param base64Image - Base64 encoded JPEG image data (without data URL prefix)
 * @returns Promise<string> - Base64 encoded rotated JPEG image
 */
export async function rotateImage180(base64Image: string): Promise<string> {
    try {
        console.log('🔄 Starting pixel-level 180° rotation for ESP32 image...');

        // Convert base64 to Uint8Array
        const imageData = Uint8Array.from(atob(base64Image), c => c.charCodeAt(0));

        // Decode the JPEG using imagescript
        const image = await Image.decode(imageData);
        console.log(`📐 Original image: ${image.width}x${image.height} pixels`);

        // Rotate the image 180 degrees
        const rotatedImage = image.rotate(180);
        console.log(`🔄 Image rotated 180° successfully`);

        // Encode back to JPEG using the encodeJPEG method
        const rotatedJpegData = await rotatedImage.encodeJPEG(90); // 90% quality

        // Convert back to base64
        const rotatedBase64 = btoa(String.fromCharCode(...rotatedJpegData));

        const originalSizeKB = Math.round(base64Image.length * 3 / 4 / 1024);
        const rotatedSizeKB = Math.round(rotatedBase64.length * 3 / 4 / 1024);

        console.log(`✅ ESP32 image rotation completed: ${originalSizeKB}KB → ${rotatedSizeKB}KB`);

        return rotatedBase64;

    } catch (error) {
        console.error('❌ Error during pixel-level image rotation:', error);
        console.warn('⚠️  Returning original image without rotation');
        return base64Image;
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
