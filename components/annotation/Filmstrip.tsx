"use client";

import { useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Asset {
  id: string;
  fileName: string;
  storageUrl: string;
}

interface FilmstripProps {
  assets: Asset[];
  currentIndex: number;
  onSelect: (index: number) => void;
  annotationCounts?: Record<string, number>;
  className?: string;
}

export function Filmstrip({
  assets,
  currentIndex,
  onSelect,
  annotationCounts = {},
  className,
}: FilmstripProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Auto-scroll to keep current item visible
  useEffect(() => {
    const currentItem = itemRefs.current[currentIndex];
    if (currentItem && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const itemLeft = currentItem.offsetLeft;
      const itemWidth = currentItem.offsetWidth;
      const containerWidth = container.clientWidth;
      const scrollLeft = container.scrollLeft;

      // Check if item is outside visible area
      if (itemLeft < scrollLeft) {
        // Item is to the left - scroll to show it with some padding
        container.scrollTo({
          left: itemLeft - 16,
          behavior: "smooth",
        });
      } else if (itemLeft + itemWidth > scrollLeft + containerWidth) {
        // Item is to the right - scroll to show it with some padding
        container.scrollTo({
          left: itemLeft + itemWidth - containerWidth + 16,
          behavior: "smooth",
        });
      }
    }
  }, [currentIndex]);

  const scrollLeft = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollBy({
        left: -200,
        behavior: "smooth",
      });
    }
  }, []);

  const scrollRight = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollBy({
        left: 200,
        behavior: "smooth",
      });
    }
  }, []);

  if (assets.length === 0) {
    return (
      <div className={cn("h-20 bg-gray-100 flex items-center justify-center text-gray-500 text-sm", className)}>
        No images in this project
      </div>
    );
  }

  return (
    <div className={cn("relative flex items-center bg-gray-900 h-20", className)}>
      {/* Left scroll button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={scrollLeft}
        className="absolute left-0 z-10 h-full w-8 bg-gradient-to-r from-gray-900 to-transparent text-white hover:bg-transparent hover:text-white/80 rounded-none"
      >
        <ChevronLeft className="h-5 w-5" />
      </Button>

      {/* Scrollable filmstrip */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-x-auto scrollbar-hide mx-8 py-2"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        <div className="flex gap-1.5 px-2">
          {assets.map((asset, index) => {
            const isSelected = index === currentIndex;
            const annotationCount = annotationCounts[asset.id] || 0;

            return (
              <button
                key={asset.id}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                onClick={() => onSelect(index)}
                className={cn(
                  "relative flex-shrink-0 w-16 h-14 rounded overflow-hidden transition-all",
                  "hover:ring-2 hover:ring-blue-400",
                  isSelected
                    ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900"
                    : "opacity-60 hover:opacity-100"
                )}
                title={`${asset.fileName} (${index + 1}/${assets.length})`}
              >
                {/* Thumbnail */}
                <Image
                  src={asset.storageUrl}
                  alt={asset.fileName}
                  fill
                  className="object-cover"
                  sizes="64px"
                  unoptimized
                />

                {/* Index number */}
                <span className="absolute bottom-0 left-0 right-0 text-[10px] text-white bg-black/60 text-center py-0.5 font-mono">
                  {index + 1}
                </span>

                {/* Annotation count badge */}
                {annotationCount > 0 && (
                  <span className="absolute top-0.5 right-0.5 bg-green-500 text-white text-[9px] font-bold px-1 py-0.5 rounded-full min-w-[14px] text-center leading-none">
                    {annotationCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Right scroll button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={scrollRight}
        className="absolute right-0 z-10 h-full w-8 bg-gradient-to-l from-gray-900 to-transparent text-white hover:bg-transparent hover:text-white/80 rounded-none"
      >
        <ChevronRight className="h-5 w-5" />
      </Button>

      {/* Progress indicator */}
      <div className="absolute bottom-0 left-8 right-8 h-0.5 bg-gray-700">
        <div
          className="h-full bg-blue-500 transition-all duration-300"
          style={{ width: `${((currentIndex + 1) / assets.length) * 100}%` }}
        />
      </div>
    </div>
  );
}
