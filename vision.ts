import { apiKeyManager, getGeminiVisionUrl } from "./config.ts";

export async function callGeminiVision(base64Image: string, prompt: string): Promise<string> {
  console.log("Calling Gemini Vision API");

  const currentKey = apiKeyManager.getCurrentKey();
  if (!currentKey) {
      console.error("Cannot call Gemini Vision: Missing API Key.");
      return "Error: Vision API Key not configured.";
  }
   if (!base64Image) {
        console.error("Cannot call Gemini Vision: No image data provided.");
        return "Error: No image data received.";
    }

  // Retry logic with key rotation for quota exceeded errors
  let maxRetries = apiKeyManager.getTotalKeys();
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      const body = {
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: "image/jpeg",
                  data: base64Image
                }
              },
              {
                text: (prompt+"Response maximum 3 sentences.") || "Describe this image in maximum 3 sentences."
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0,
          thinkingConfig: {
            thinkingBudget: 500,
          },
        },
      };

      const visionUrl = getGeminiVisionUrl();
      const resp = await fetch(visionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = await resp.json();

      if (!resp.ok || result?.error) {
        // Check if it's a quota exceeded error
        const errorMessage = result?.error?.message || resp.statusText;
        const isQuotaError = resp.status === 429 ||
                           errorMessage.toLowerCase().includes("quota") ||
                           errorMessage.toLowerCase().includes("rate limit");

        if (isQuotaError && retryCount < maxRetries - 1) {
          console.warn(`Gemini Vision quota exceeded with key ${retryCount + 1}/${maxRetries}. Rotating to next key...`);
          apiKeyManager.rotateToNextKey();
          retryCount++;
          continue; // Try with next key
        }

        console.error("Gemini Vision API error:", result?.error || `HTTP Status ${resp.status}`);
        return `Error analyzing the image: ${errorMessage}`;
      }

      // Extract text, handling potential variations in response structure
      const candidates = result?.candidates;
      if (!candidates || candidates.length === 0) {
        console.error("Gemini Vision: No candidates returned.", result);
        return "(No description returned from Vision API)";
      }
      const content = candidates[0]?.content;
      if (!content || !content.parts || content.parts.length === 0) {
        console.error("Gemini Vision: No content parts returned.", result);
        return "(No description content returned from Vision API)";
      }

      const text = content.parts
        ?.map((p: any) => p.text)
        ?.filter(Boolean) // Filter out any null/undefined text parts
        ?.join(" ") || "(No text description found)"; // Join with space, provide default

      return text;

    } catch (err) {
      // Check if it's a network/quota error that might benefit from key rotation
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isQuotaError = errorMessage.toLowerCase().includes("quota") ||
                          errorMessage.toLowerCase().includes("rate limit") ||
                          errorMessage.toLowerCase().includes("429");

      if (isQuotaError && retryCount < maxRetries - 1) {
        console.warn(`Gemini Vision network error (quota-related) with key ${retryCount + 1}/${maxRetries}. Rotating to next key...`);
        apiKeyManager.rotateToNextKey();
        retryCount++;
        continue; // Try with next key
      }

      console.error("callGeminiVision fetch/processing error:", err);
      return `Error analyzing the image (Network/Processing failed: ${errorMessage}).`;
    }
  }

  // If we get here, all keys have been exhausted
  console.error("All API keys exhausted for Gemini Vision");
  return "Error: All API keys have been exhausted. Please try again later.";
}