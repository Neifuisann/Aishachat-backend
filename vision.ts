import { GEMINI_API_KEY, GEMINI_VISION_URL } from "./config.ts";

export async function callGeminiVision(base64Image: string, prompt: string): Promise<string> {
  console.log("Calling Gemini Vision API");
  if (!GEMINI_API_KEY) {
      console.error("Cannot call Gemini Vision: Missing API Key.");
      return "Error: Vision API Key not configured.";
  }
   if (!base64Image) {
        console.error("Cannot call Gemini Vision: No image data provided.");
        return "Error: No image data received.";
    }

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
              text: prompt || "Describe this image in maximum 10 sentences."
            }
          ]
        }
      ],
    };

    const resp = await fetch(GEMINI_VISION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await resp.json();

    if (!resp.ok || result?.error) {
      console.error("Gemini Vision API error:", result?.error || `HTTP Status ${resp.status}`);
      return `Error analyzing the image: ${result?.error?.message || resp.statusText}`;
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
    console.error("callGeminiVision fetch/processing error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    return `Error analyzing the image (Network/Processing failed: ${errorMessage}).`;
  }
} 