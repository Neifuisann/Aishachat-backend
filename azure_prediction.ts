import { Logger } from './logger.ts';

const logger = new Logger('[AzurePrediction]');

const ENDPOINT =
    'https://neimon-prediction.cognitiveservices.azure.com/customvision/v3.0/Prediction/5a4fa886-b85c-448d-9195-a42e4e332504/classify/iterations/Iteration1/image';

const KEY =
    '3O2Mek7lJbexaAwJ3oy4BwtrwSM8Z2fNmEJ7YPh9YYpgCBahr617JQQJ99BFACqBBLyXJ3w3AAAIACOGJ5Vd';

export interface AzureBillPrediction {
    tagName: string;
    probability: number;
}

export async function getAzureMoneyClassification(
    base64Image: string | ArrayBuffer,
): Promise<{ predictions: AzureBillPrediction[] }> {
    try {
        const binary =
            base64Image instanceof ArrayBuffer
                ? new Uint8Array(base64Image)
                : Uint8Array.from(atob(base64Image), (c) => c.charCodeAt(0));

        const resp = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Prediction-Key': KEY,
            },
            body: binary,
        });

        if (!resp.ok) {
            const txt = await resp.text();
            logger.error('Azure prediction error', resp.status, txt);
            throw new Error(`Azure returned ${resp.status}`);
        }

        const json = await resp.json();

        return {
            predictions: (json.predictions ?? []).map((p: any) => ({
                tagName: p.tagName,
                probability: p.probability,
            })),
        };
    } catch (err) {
        logger.error('Azure money classification failed', err);
        return { predictions: [] };
    }
}
