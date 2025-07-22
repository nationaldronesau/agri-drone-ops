// Roboflow API Service for Weed Detection
import { Detection, RoboflowResponse } from '@/types/roboflow';

// Available models for different weed types
export const ROBOFLOW_MODELS = {
  LANTANA_SAHI: {
    name: 'Lantana Detection (SAHI)',
    endpoint: 'https://serverless.roboflow.com/infer/workflows/smartdata-ggzkp/small-object-detection-sahi',
    color: '#FE0056',
    classes: ['Lantana', 'Wattle'],
    description: 'Small object detection with automatic image slicing',
  },
  WATTLE_ONLY: {
    name: 'Wattle Detection (Segmentation)',
    projectId: 'wattle',
    version: 2,
    color: '#C7FC00',
    classes: ['Wattle'],
    disabled: true, // Keep disabled until we get the endpoint
  },
  PINE_SAPLINGS: {
    name: 'Pine Saplings Detection',
    projectId: 'pine-saplings-2',
    version: 2,
    color: '#00B7EB',
    classes: ['Pine-Saplings'],
    disabled: true, // Keep disabled until we get the endpoint
  },
  // Placeholder for future models
  BELLYACHE_BUSH: {
    name: 'Bellyache Bush (Coming Soon)',
    projectId: 'bellyache-bush-detection',
    version: 1,
    color: '#45B7D1',
    classes: ['Bellyache Bush'],
    disabled: true,
  },
} as const;

export type ModelType = keyof typeof ROBOFLOW_MODELS;

class RoboflowService {
  private apiKey: string;
  private baseUrl: string = 'https://detect.roboflow.com';

  constructor() {
    this.apiKey = process.env.ROBOFLOW_API_KEY || '';
    if (!this.apiKey) {
      console.warn('ROBOFLOW_API_KEY not set in environment variables');
    }
  }

  /**
   * Run detection on an image using specified model
   */
  async detectWeeds(
    imageBase64: string,
    modelType: ModelType
  ): Promise<Detection[]> {
    if (!this.apiKey) {
      throw new Error('Roboflow API key not configured');
    }

    const model = ROBOFLOW_MODELS[modelType];
    
    // Check if model is disabled
    if (model.disabled) {
      console.warn(`Model ${modelType} is disabled`);
      return [];
    }

    try {
      let response;
      let data;

      // Handle SAHI workflow endpoint (new format)
      if (model.endpoint) {
        console.log(`Using SAHI workflow endpoint for ${modelType}`);
        
        response = await fetch(model.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            api_key: this.apiKey,
            inputs: {
              image: {
                type: "base64",
                value: imageBase64
              }
            }
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Roboflow SAHI API error: ${response.statusText} - ${errorText}`);
        }

        data = await response.json();
        console.log('SAHI response:', data);
        
        // SAHI workflow returns results in a different format
        // Need to extract predictions from the workflow output
        const predictions = data.results?.image?.predictions || data.predictions || [];
        
        return predictions.map((pred: any) => ({
          id: crypto.randomUUID(),
          class: pred.class || pred.class_name,
          confidence: pred.confidence,
          x: pred.x,
          y: pred.y,
          width: pred.width,
          height: pred.height,
          modelType,
          color: model.color,
        }));

      } else {
        // Handle legacy direct model endpoint (old format)
        const url = `${this.baseUrl}/${model.projectId}/${model.version}`;
        
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            api_key: this.apiKey,
            image: imageBase64,
            confidence: 0.4,
            overlap: 0.3,
          }),
        });

        if (!response.ok) {
          throw new Error(`Roboflow API error: ${response.statusText}`);
        }

        data = await response.json();
        
        return data.predictions.map((pred: any) => ({
          id: crypto.randomUUID(),
          class: pred.class,
          confidence: pred.confidence,
          x: pred.x,
          y: pred.y,
          width: pred.width,
          height: pred.height,
          modelType,
          color: model.color,
        }));
      }
      
    } catch (error) {
      console.error('Roboflow detection error:', error);
      throw error;
    }
  }

  /**
   * Run detection on multiple models for comprehensive analysis
   */
  async detectMultipleModels(
    imageBase64: string,
    models: ModelType[] = this.getEnabledModels()
  ): Promise<Detection[]> {
    // Filter out disabled models
    const enabledModels = models.filter(modelType => !ROBOFLOW_MODELS[modelType].disabled);
    
    if (enabledModels.length === 0) {
      console.warn('No enabled models available for detection');
      return [];
    }

    console.log(`Running detection on ${enabledModels.length} enabled models:`, enabledModels);

    const detectionPromises = enabledModels.map((modelType) =>
      this.detectWeeds(imageBase64, modelType).catch((error) => {
        console.error(`Failed to run ${modelType} detection:`, error);
        return [] as Detection[];
      })
    );

    const results = await Promise.all(detectionPromises);
    return results.flat();
  }

  /**
   * Get list of enabled models
   */
  getEnabledModels(): ModelType[] {
    return Object.keys(ROBOFLOW_MODELS).filter(
      modelType => !ROBOFLOW_MODELS[modelType as ModelType].disabled
    ) as ModelType[];
  }

  /**
   * Convert image file to base64
   */
  async imageToBase64(file: File | Buffer): Promise<string> {
    if (file instanceof File) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result as string;
          // Remove data URL prefix
          resolve(base64.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    } else {
      // Handle Buffer (from server-side)
      return file.toString('base64');
    }
  }
}

// Export singleton instance
export const roboflowService = new RoboflowService();