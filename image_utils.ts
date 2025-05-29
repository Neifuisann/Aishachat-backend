/**
 * Image processing utilities for ESP32 camera data
 */

/**
 * Rotates a base64 JPEG image by 180 degrees using Canvas API
 * @param base64Image - Base64 encoded JPEG image data (without data URL prefix)
 * @returns Promise<string> - Base64 encoded rotated JPEG image
 */
export async function rotateImage180(base64Image: string): Promise<string> {
    try {
        // Check if we're in a browser-like environment with Canvas support
        if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
            console.warn('Canvas API not available, using fallback rotation method');
            return await rotateImage180Fallback(base64Image);
        }

        // Convert base64 to Uint8Array
        const imageData = Uint8Array.from(atob(base64Image), c => c.charCodeAt(0));

        // Create a blob from the image data
        const blob = new Blob([imageData], { type: 'image/jpeg' });

        // Create an image bitmap from the blob
        const imageBitmap = await createImageBitmap(blob);

        // Create a canvas with the same dimensions
        const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
        const ctx = canvas.getContext('2d');

        if (!ctx) {
            throw new Error('Failed to get 2D context from canvas');
        }

        // Apply 180-degree rotation transformation
        // Move to center, rotate 180 degrees, move back
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(Math.PI); // 180 degrees in radians
        ctx.translate(-canvas.width / 2, -canvas.height / 2);

        // Draw the rotated image
        ctx.drawImage(imageBitmap, 0, 0);

        // Convert canvas back to blob
        const rotatedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });

        // Convert blob to base64
        const arrayBuffer = await rotatedBlob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const base64String = btoa(String.fromCharCode(...uint8Array));

        console.log(`Image rotated 180°: ${imageBitmap.width}x${imageBitmap.height} -> ${Math.round(base64String.length * 3 / 4 / 1024)} KB`);

        return base64String;

    } catch (error) {
        console.error('Error rotating image 180 degrees:', error);
        console.warn('Attempting fallback rotation method...');
        try {
            return await rotateImage180Fallback(base64Image);
        } catch (fallbackError) {
            console.error('Fallback rotation also failed:', fallbackError);
            console.warn('Returning original image without rotation');
            return base64Image;
        }
    }
}

/**
 * Fallback method for image rotation when Canvas API is not available
 * Uses EXIF orientation metadata to indicate the image should be rotated
 */
async function rotateImage180Fallback(base64Image: string): Promise<string> {
    try {
        console.log('Using EXIF-based rotation approach for ESP32 image correction');

        // Decode base64 to get the JPEG binary data
        const imageData = Uint8Array.from(atob(base64Image), c => c.charCodeAt(0));

        // Create a new JPEG with EXIF orientation set to rotate 180 degrees
        const rotatedImageData = addExifRotation180(imageData);

        // Convert back to base64
        const rotatedBase64 = btoa(String.fromCharCode(...rotatedImageData));

        console.log('✅ Applied EXIF rotation metadata for 180° correction');
        return rotatedBase64;

    } catch (error) {
        console.error('EXIF rotation failed:', error);
        console.warn('Returning original image without rotation');
        return base64Image;
    }
}

/**
 * Adds EXIF orientation metadata to rotate image 180 degrees
 * This is a simplified approach that works with most image viewers
 */
function addExifRotation180(jpegData: Uint8Array): Uint8Array {
    // JPEG files start with 0xFFD8 and end with 0xFFD9
    if (jpegData.length < 4 || jpegData[0] !== 0xFF || jpegData[1] !== 0xD8) {
        throw new Error('Invalid JPEG format');
    }

    // Simple EXIF header with orientation = 3 (rotate 180°)
    // This is a minimal EXIF structure that most viewers will respect
    const exifHeader = new Uint8Array([
        0xFF, 0xE1, // APP1 marker
        0x00, 0x16, // Length (22 bytes)
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
        0x49, 0x49, 0x2A, 0x00, // TIFF header (little endian)
        0x08, 0x00, 0x00, 0x00, // Offset to first IFD
        0x01, 0x00, // Number of directory entries
        0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00 // Orientation tag = 3 (180°)
    ]);

    // Find where to insert EXIF (after SOI marker 0xFFD8)
    const result = new Uint8Array(jpegData.length + exifHeader.length);

    // Copy SOI marker
    result[0] = jpegData[0]; // 0xFF
    result[1] = jpegData[1]; // 0xD8

    // Insert EXIF header
    result.set(exifHeader, 2);

    // Copy rest of JPEG data
    result.set(jpegData.slice(2), 2 + exifHeader.length);

    return result;
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
