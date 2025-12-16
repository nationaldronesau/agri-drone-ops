// Advanced Roboflow Service with Large Image Handling
import { Detection, RoboflowResponse } from '@/types/roboflow';
import { roboflowService, ModelType, ROBOFLOW_MODELS } from './roboflow';

interface ImageTile {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TileDetection extends Detection {
  tileX: number;
  tileY: number;
  originalX: number;
  originalY: number;
}

export class AdvancedRoboflowService {
  private maxImageSize = 1024; // Roboflow inference limit
  private tileOverlap = 128;   // Overlap to prevent edge detection loss
  private minConfidence = 0.4;

  /**
   * Process large images by breaking them into tiles
   */
  async processLargeImage(
    imageFile: File | Buffer,
    modelTypes: ModelType[],
    maxDimension: number = 4000
  ): Promise<Detection[]> {
    
    // Convert to image element for processing
    const img = await this.fileToImage(imageFile);
    
    console.log(`Processing large image: ${img.width}x${img.height}px`);
    
    // Check if image needs tiling
    if (img.width <= this.maxImageSize && img.height <= this.maxImageSize) {
      console.log('Image small enough, processing directly');
      const base64 = await this.imageToBase64(img);
      const result = await roboflowService.detectMultipleModels(base64, modelTypes);
      // Log any failures but still return successful detections
      if (result.failures.length > 0) {
        console.warn(`Model failures during direct processing: ${result.failures.map(f => f.model).join(', ')}`);
      }
      return result.detections;
    }
    
    // Generate tiles for large image
    const tiles = this.generateTiles(img);
    console.log(`Generated ${tiles.length} tiles for processing`);
    
    // Process each tile through Roboflow
    const allDetections: TileDetection[] = [];
    
    for (const tile of tiles) {
      try {
        const tileBase64 = this.canvasToBase64(tile.canvas);
        const result = await roboflowService.detectMultipleModels(tileBase64, modelTypes);

        // Log any failures but continue processing
        if (result.failures.length > 0) {
          console.warn(`Model failures for tile at ${tile.x},${tile.y}: ${result.failures.map(f => f.model).join(', ')}`);
        }

        // Convert tile coordinates to full image coordinates
        const convertedDetections = result.detections.map(detection => ({
          ...detection,
          tileX: detection.x,
          tileY: detection.y,
          originalX: tile.x + detection.x,
          originalY: tile.y + detection.y,
          x: tile.x + detection.x,
          y: tile.y + detection.y,
        })) as TileDetection[];

        allDetections.push(...convertedDetections);

      } catch (error) {
        console.error(`Failed to process tile at ${tile.x},${tile.y}:`, error);
      }
    }
    
    // Merge overlapping detections from different tiles
    const mergedDetections = this.mergeOverlappingDetections(allDetections);
    
    console.log(`Processed ${tiles.length} tiles, found ${mergedDetections.length} unique detections`);
    return mergedDetections;
  }
  
  /**
   * Generate overlapping tiles from large image
   */
  private generateTiles(img: HTMLImageElement): ImageTile[] {
    const tiles: ImageTile[] = [];
    const stepSize = this.maxImageSize - this.tileOverlap;
    
    for (let y = 0; y < img.height; y += stepSize) {
      for (let x = 0; x < img.width; x += stepSize) {
        const tileWidth = Math.min(this.maxImageSize, img.width - x);
        const tileHeight = Math.min(this.maxImageSize, img.height - y);
        
        // Create canvas for this tile
        const canvas = document.createElement('canvas');
        canvas.width = tileWidth;
        canvas.height = tileHeight;
        
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(
          img,
          x, y, tileWidth, tileHeight,  // Source
          0, 0, tileWidth, tileHeight   // Destination
        );
        
        tiles.push({
          canvas,
          x,
          y,
          width: tileWidth,
          height: tileHeight,
        });
      }
    }
    
    return tiles;
  }
  
  /**
   * Merge detections that overlap across tile boundaries
   */
  private mergeOverlappingDetections(detections: TileDetection[]): Detection[] {
    const merged: Detection[] = [];
    const used = new Set<number>();
    
    for (let i = 0; i < detections.length; i++) {
      if (used.has(i)) continue;
      
      const current = detections[i];
      const overlapping = [current];
      
      // Find all detections that overlap with current one
      for (let j = i + 1; j < detections.length; j++) {
        if (used.has(j)) continue;
        
        const other = detections[j];
        if (this.detectionsOverlap(current, other)) {
          overlapping.push(other);
          used.add(j);
        }
      }
      
      // Merge overlapping detections (keep highest confidence)
      const best = overlapping.reduce((prev, curr) => 
        curr.confidence > prev.confidence ? curr : prev
      );
      
      merged.push({
        id: best.id,
        class: best.class,
        confidence: best.confidence,
        x: best.originalX,
        y: best.originalY,
        width: best.width,
        height: best.height,
        modelType: best.modelType,
        color: best.color,
      });
      
      used.add(i);
    }
    
    return merged;
  }
  
  /**
   * Check if two detections overlap (for merging)
   */
  private detectionsOverlap(a: TileDetection, b: TileDetection): boolean {
    const threshold = 0.5; // 50% overlap threshold
    
    const aLeft = a.originalX - a.width / 2;
    const aRight = a.originalX + a.width / 2;
    const aTop = a.originalY - a.height / 2;
    const aBottom = a.originalY + a.height / 2;
    
    const bLeft = b.originalX - b.width / 2;
    const bRight = b.originalX + b.width / 2;
    const bTop = b.originalY - b.height / 2;
    const bBottom = b.originalY + b.height / 2;
    
    const overlapWidth = Math.max(0, Math.min(aRight, bRight) - Math.max(aLeft, bLeft));
    const overlapHeight = Math.max(0, Math.min(aBottom, bBottom) - Math.max(aTop, bTop));
    const overlapArea = overlapWidth * overlapHeight;
    
    const aArea = a.width * a.height;
    const bArea = b.width * b.height;
    const minArea = Math.min(aArea, bArea);
    
    return (overlapArea / minArea) > threshold;
  }
  
  /**
   * Convert File/Buffer to HTMLImageElement
   */
  private async fileToImage(file: File | Buffer): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      
      if (file instanceof File) {
        img.src = URL.createObjectURL(file);
      } else {
        // Convert buffer to blob
        const blob = new Blob([file]);
        img.src = URL.createObjectURL(blob);
      }
    });
  }
  
  /**
   * Convert HTMLImageElement to base64
   */
  private async imageToBase64(img: HTMLImageElement): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  }
  
  /**
   * Convert canvas to base64
   */
  private canvasToBase64(canvas: HTMLCanvasElement): string {
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  }
  
  /**
   * Get optimal tile size based on image dimensions
   */
  getOptimalTileSize(imageWidth: number, imageHeight: number): {
    tileSize: number;
    tilesX: number;
    tilesY: number;
    totalTiles: number;
  } {
    const stepSize = this.maxImageSize - this.tileOverlap;
    const tilesX = Math.ceil(imageWidth / stepSize);
    const tilesY = Math.ceil(imageHeight / stepSize);
    
    return {
      tileSize: this.maxImageSize,
      tilesX,
      tilesY,
      totalTiles: tilesX * tilesY,
    };
  }
}

export const advancedRoboflowService = new AdvancedRoboflowService();