import { NextRequest } from "next/server";
import { getAuthenticatedUser, getUserTeamIds } from "@/lib/auth/api-auth";
import prisma from "@/lib/db";
import {
  generateShapefileExport,
  type DetectionRecord,
  type AnnotationRecord,
} from "@/lib/services/shapefile";

const BATCH_SIZE = 500; // Process 500 records at a time
const QUERY_TIMEOUT = 30000; // 30 second timeout for database queries

// Statistics tracking for export
interface ExportStats {
  totalProcessed: number;
  exported: number;
  skippedInvalidCoords: number;
  errors: string[];
}

/**
 * Streaming export endpoint for large datasets
 * Processes data in batches to avoid memory issues
 *
 * Query params:
 * - format: 'csv' | 'kml' (default: csv)
 * - projectId: optional project filter
 * - includeAI: 'true' | 'false' (default: true)
 * - includeManual: 'true' | 'false' (default: true)
 * - classes: comma-separated list of class names to include
 */
export async function GET(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser();
  if (!auth.authenticated) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get user's teams
  const userTeams = await getUserTeamIds();
  if (userTeams.dbError) {
    return new Response(JSON.stringify({ error: "Database error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const searchParams = request.nextUrl.searchParams;
  const format = searchParams.get("format") || "csv";
  const projectId = searchParams.get("projectId");
  const includeAI = searchParams.get("includeAI") !== "false";
  const includeManual = searchParams.get("includeManual") !== "false";
  const includePending = searchParams.get("includePending") === "true";
  const classFilter = searchParams.get("classes")?.split(",").filter(Boolean) || [];

  // Validate format
  if (format !== "csv" && format !== "kml" && format !== "shapefile") {
    return new Response(JSON.stringify({ error: "Invalid format. Use 'csv', 'kml', or 'shapefile'" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Build base where clause for team access
  const baseWhere: any = {
    asset: {
      project: {
        teamId: { in: userTeams.teamIds },
      },
    },
  };

  if (projectId && projectId !== "all") {
    baseWhere.asset.projectId = projectId;
  }

  // Shapefile export uses a different approach (generates ZIP, not streaming text)
  if (format === "shapefile") {
    return handleShapefileExport(baseWhere, includeAI, includeManual, classFilter);
  }

  // Create streaming response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const stats: ExportStats = {
        totalProcessed: 0,
        exported: 0,
        skippedInvalidCoords: 0,
        errors: [],
      };

      try {
        if (format === "csv") {
          await streamCSV(controller, encoder, baseWhere, includeAI, includeManual, includePending, classFilter, stats);
        } else {
          await streamKML(controller, encoder, baseWhere, includeAI, includeManual, includePending, classFilter, stats);
        }
      } catch (error) {
        console.error("Export stream error:", error);
        stats.errors.push(error instanceof Error ? error.message : "Unknown error");

        // Write error marker into stream so users know export failed
        if (format === "csv") {
          controller.enqueue(
            encoder.encode(`\n# ERROR: Export failed - ${stats.errors.join("; ")}\n`)
          );
          controller.enqueue(
            encoder.encode(`# Records exported before failure: ${stats.exported}\n`)
          );
        } else {
          // For KML, write a comment and close the document properly
          controller.enqueue(
            encoder.encode(`    <!-- ERROR: Export failed - ${escapeXML(stats.errors.join("; "))} -->\n`)
          );
          controller.enqueue(
            encoder.encode(`    <!-- Records exported before failure: ${stats.exported} -->\n`)
          );
          controller.enqueue(encoder.encode(`  </Document>\n</kml>\n`));
        }
      }

      controller.close();
    },
  });

  const contentType = format === "csv" ? "text/csv" : "application/vnd.google-earth.kml+xml";
  const filename = `detections-${new Date().toISOString().split("T")[0]}.${format}`;

  return new Response(stream, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Transfer-Encoding": "chunked",
    },
  });
}

/**
 * Stream CSV format in batches
 */
async function streamCSV(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  baseWhere: any,
  includeAI: boolean,
  includeManual: boolean,
  includePending: boolean,
  classFilter: string[],
  stats: ExportStats
) {
  // Write CSV header
  controller.enqueue(
    encoder.encode("ID,Type,Class,Latitude,Longitude,Confidence,Image,Project,Location,Date\n")
  );

  // Process AI detections in batches
  if (includeAI) {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const detections = await queryWithTimeout(
        prisma.detection.findMany({
          where: {
            ...baseWhere,
            type: "AI",
            ...(classFilter.length > 0 ? { className: { in: classFilter } } : {}),
          },
          include: {
            asset: {
              select: {
                fileName: true,
                project: {
                  select: {
                    name: true,
                    location: true,
                  },
                },
              },
            },
          },
          skip: offset,
          take: BATCH_SIZE,
          orderBy: { createdAt: "desc" },
        }),
        QUERY_TIMEOUT
      );

      for (const detection of detections) {
        stats.totalProcessed++;

        // Skip invalid coordinates
        if (!isValidCoordinate(detection.centerLat, detection.centerLon)) {
          stats.skippedInvalidCoords++;
          continue;
        }

        const row = [
          escapeCSV(detection.id),
          "AI",
          escapeCSV(detection.className),
          detection.centerLat?.toFixed(8) || "",
          detection.centerLon?.toFixed(8) || "",
          ((detection.confidence || 0) * 100).toFixed(1) + "%",
          escapeCSV(detection.asset.fileName),
          escapeCSV(detection.asset.project?.name || ""),
          escapeCSV(detection.asset.project?.location || ""),
          detection.createdAt.toISOString().split("T")[0],
        ].join(",");

        controller.enqueue(encoder.encode(row + "\n"));
        stats.exported++;
      }

      offset += BATCH_SIZE;
      hasMore = detections.length === BATCH_SIZE;
    }
  }

  // Process manual annotations in batches
  if (includeManual) {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const annotations = await queryWithTimeout(
        prisma.manualAnnotation.findMany({
          where: {
            session: {
              asset: baseWhere.asset,
            },
            ...(classFilter.length > 0 ? { weedType: { in: classFilter } } : {}),
          },
          select: {
            id: true,
            weedType: true,
            confidence: true,
            centerLat: true,
            centerLon: true,
            createdAt: true,
            session: {
              select: {
                asset: {
                  select: {
                    fileName: true,
                    project: {
                      select: {
                        name: true,
                        location: true,
                      },
                    },
                  },
                },
              },
            },
          },
          skip: offset,
          take: BATCH_SIZE,
          orderBy: { createdAt: "desc" },
        }),
        QUERY_TIMEOUT
      );

      for (const annotation of annotations) {
        stats.totalProcessed++;

        // Get center coordinates from annotation
        const centerLat = annotation.centerLat;
        const centerLon = annotation.centerLon;

        // Skip invalid coordinates
        if (!isValidCoordinate(centerLat, centerLon)) {
          stats.skippedInvalidCoords++;
          continue;
        }

        const confidenceValue =
          annotation.confidence === "CERTAIN"
            ? 0.95
            : annotation.confidence === "LIKELY"
              ? 0.75
              : 0.5;

        const row = [
          escapeCSV(annotation.id),
          "Manual",
          escapeCSV(annotation.weedType),
          centerLat?.toFixed(8) || "",
          centerLon?.toFixed(8) || "",
          (confidenceValue * 100).toFixed(1) + "%",
          escapeCSV(annotation.session.asset.fileName),
          escapeCSV(annotation.session.asset.project?.name || ""),
          escapeCSV(annotation.session.asset.project?.location || ""),
          annotation.createdAt.toISOString().split("T")[0],
        ].join(",");

        controller.enqueue(encoder.encode(row + "\n"));
        stats.exported++;
      }

      offset += BATCH_SIZE;
      hasMore = annotations.length === BATCH_SIZE;
    }
  }

  // Write summary as CSV comment at the end
  controller.enqueue(encoder.encode(`\n# Export Summary\n`));
  controller.enqueue(encoder.encode(`# Total records processed: ${stats.totalProcessed}\n`));
  controller.enqueue(encoder.encode(`# Records exported: ${stats.exported}\n`));
  if (stats.skippedInvalidCoords > 0) {
    controller.enqueue(
      encoder.encode(`# WARNING: ${stats.skippedInvalidCoords} records skipped due to invalid coordinates\n`)
    );
  }

  // Process SAM3 pending annotations in batches
  if (includePending) {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const pending = await queryWithTimeout(
        prisma.pendingAnnotation.findMany({
          where: {
            status: "PENDING",
            asset: baseWhere.asset,
            ...(classFilter.length > 0 ? { weedType: { in: classFilter } } : {}),
          },
          select: {
            id: true,
            weedType: true,
            confidence: true,
            centerLat: true,
            centerLon: true,
            createdAt: true,
            asset: {
              select: {
                fileName: true,
                project: {
                  select: {
                    name: true,
                    location: true,
                  },
                },
              },
            },
          },
          skip: offset,
          take: BATCH_SIZE,
          orderBy: { createdAt: "desc" },
        }),
        QUERY_TIMEOUT
      );

      for (const annotation of pending) {
        stats.totalProcessed++;

        const centerLat = annotation.centerLat;
        const centerLon = annotation.centerLon;

        if (!isValidCoordinate(centerLat, centerLon)) {
          stats.skippedInvalidCoords++;
          continue;
        }

        const row = [
          escapeCSV(annotation.id),
          "SAM3",
          escapeCSV(annotation.weedType),
          centerLat?.toFixed(8) || "",
          centerLon?.toFixed(8) || "",
          ((annotation.confidence || 0) * 100).toFixed(1) + "%",
          escapeCSV(annotation.asset.fileName),
          escapeCSV(annotation.asset.project?.name || ""),
          escapeCSV(annotation.asset.project?.location || ""),
          annotation.createdAt.toISOString().split("T")[0],
        ].join(",");

        controller.enqueue(encoder.encode(row + "\n"));
        stats.exported++;
      }

      offset += BATCH_SIZE;
      hasMore = pending.length === BATCH_SIZE;
    }
  }
}

/**
 * Stream KML format in batches
 */
async function streamKML(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  baseWhere: any,
  includeAI: boolean,
  includeManual: boolean,
  includePending: boolean,
  classFilter: string[],
  stats: ExportStats
) {
  // Write KML header
  controller.enqueue(
    encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Weed Detections - ${new Date().toLocaleDateString()}</name>
    <description>Exported from AgriDrone Ops (Streaming)</description>
    <Style id="ai-detection">
      <IconStyle>
        <color>ff0000ff</color>
        <scale>1.0</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
      </IconStyle>
    </Style>
    <Style id="manual-annotation">
      <IconStyle>
        <color>ff00ff00</color>
        <scale>1.0</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
      </IconStyle>
    </Style>
`)
  );

  // Process AI detections in batches
  if (includeAI) {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const detections = await queryWithTimeout(
        prisma.detection.findMany({
          where: {
            ...baseWhere,
            type: "AI",
            ...(classFilter.length > 0 ? { className: { in: classFilter } } : {}),
          },
          include: {
            asset: {
              select: {
                fileName: true,
                project: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
          skip: offset,
          take: BATCH_SIZE,
          orderBy: { createdAt: "desc" },
        }),
        QUERY_TIMEOUT
      );

      for (const detection of detections) {
        stats.totalProcessed++;

        // Skip invalid coordinates
        if (!isValidCoordinate(detection.centerLat, detection.centerLon)) {
          stats.skippedInvalidCoords++;
          continue;
        }

        const placemark = `    <Placemark>
      <name>${escapeXML(detection.className)} (AI)</name>
      <description>${escapeXML(`Confidence: ${((detection.confidence || 0) * 100).toFixed(1)}%\nImage: ${detection.asset.fileName}`)}</description>
      <styleUrl>#ai-detection</styleUrl>
      <Point>
        <coordinates>${detection.centerLon},${detection.centerLat},0</coordinates>
      </Point>
    </Placemark>
`;
        controller.enqueue(encoder.encode(placemark));
        stats.exported++;
      }

      offset += BATCH_SIZE;
      hasMore = detections.length === BATCH_SIZE;
    }
  }

  // Process manual annotations in batches
  if (includeManual) {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const annotations = await queryWithTimeout(
        prisma.manualAnnotation.findMany({
          where: {
            session: {
              asset: baseWhere.asset,
            },
            ...(classFilter.length > 0 ? { weedType: { in: classFilter } } : {}),
          },
          select: {
            id: true,
            weedType: true,
            confidence: true,
            centerLat: true,
            centerLon: true,
            createdAt: true,
            session: {
              select: {
                asset: {
                  select: {
                    fileName: true,
                  },
                },
              },
            },
          },
          skip: offset,
          take: BATCH_SIZE,
          orderBy: { createdAt: "desc" },
        }),
        QUERY_TIMEOUT
      );

      for (const annotation of annotations) {
        stats.totalProcessed++;

        const centerLat = annotation.centerLat;
        const centerLon = annotation.centerLon;

        // Skip invalid coordinates
        if (!isValidCoordinate(centerLat, centerLon)) {
          stats.skippedInvalidCoords++;
          continue;
        }

        const confidenceValue =
          annotation.confidence === "CERTAIN"
            ? 0.95
            : annotation.confidence === "LIKELY"
              ? 0.75
              : 0.5;

        const placemark = `    <Placemark>
      <name>${escapeXML(annotation.weedType)} (Manual)</name>
      <description>${escapeXML(`Confidence: ${(confidenceValue * 100).toFixed(1)}%\nImage: ${annotation.session.asset.fileName}`)}</description>
      <styleUrl>#manual-annotation</styleUrl>
      <Point>
        <coordinates>${centerLon},${centerLat},0</coordinates>
      </Point>
    </Placemark>
`;
        controller.enqueue(encoder.encode(placemark));
        stats.exported++;
      }

      offset += BATCH_SIZE;
      hasMore = annotations.length === BATCH_SIZE;
    }
  }

  // Process SAM3 pending annotations in batches
  if (includePending) {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const pending = await queryWithTimeout(
        prisma.pendingAnnotation.findMany({
          where: {
            status: "PENDING",
            asset: baseWhere.asset,
            ...(classFilter.length > 0 ? { weedType: { in: classFilter } } : {}),
          },
          select: {
            id: true,
            weedType: true,
            confidence: true,
            centerLat: true,
            centerLon: true,
            createdAt: true,
            asset: {
              select: {
                fileName: true,
              },
            },
          },
          skip: offset,
          take: BATCH_SIZE,
          orderBy: { createdAt: "desc" },
        }),
        QUERY_TIMEOUT
      );

      for (const annotation of pending) {
        stats.totalProcessed++;

        const centerLat = annotation.centerLat;
        const centerLon = annotation.centerLon;

        if (!isValidCoordinate(centerLat, centerLon)) {
          stats.skippedInvalidCoords++;
          continue;
        }

        const placemark = `    <Placemark>
      <name>${escapeXML(annotation.weedType)} (SAM3)</name>
      <description>${escapeXML(`Confidence: ${((annotation.confidence || 0) * 100).toFixed(1)}%\nImage: ${annotation.asset.fileName}`)}</description>
      <styleUrl>#manual-annotation</styleUrl>
      <Point>
        <coordinates>${centerLon},${centerLat},0</coordinates>
      </Point>
    </Placemark>
`;
        controller.enqueue(encoder.encode(placemark));
        stats.exported++;
      }

      offset += BATCH_SIZE;
      hasMore = pending.length === BATCH_SIZE;
    }
  }

  // Write summary as KML description/comment before closing
  let summaryDescription = `Export completed. ${stats.exported} of ${stats.totalProcessed} records exported.`;
  if (stats.skippedInvalidCoords > 0) {
    summaryDescription += ` WARNING: ${stats.skippedInvalidCoords} records had invalid coordinates and were skipped.`;
  }

  controller.enqueue(encoder.encode(`    <!-- ${escapeXML(summaryDescription)} -->\n`));

  // Write KML footer
  controller.enqueue(encoder.encode(`  </Document>
</kml>
`));
}

/**
 * Execute a Prisma query with a timeout
 */
async function queryWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Query timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Validate coordinates
 */
function isValidCoordinate(lat: number | null | undefined, lon: number | null | undefined): boolean {
  if (lat == null || lon == null) return false;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Escape CSV field
 */
function escapeCSV(field: any): string {
  const str = String(field ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Escape XML special characters
 */
function escapeXML(str: any): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Handle shapefile export
 * Generates a ZIP file containing .shp, .shx, .dbf, and .prj files
 */
async function handleShapefileExport(
  baseWhere: any,
  includeAI: boolean,
  includeManual: boolean,
  classFilter: string[]
): Promise<Response> {
  try {
    const allDetections: DetectionRecord[] = [];
    const allAnnotations: AnnotationRecord[] = [];

    // Fetch all AI detections in batches
    if (includeAI) {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const detections = await queryWithTimeout(
          prisma.detection.findMany({
            where: {
              ...baseWhere,
              type: "AI",
              ...(classFilter.length > 0 ? { className: { in: classFilter } } : {}),
            },
            select: {
              id: true,
              className: true,
              confidence: true,
              centerLat: true,
              centerLon: true,
              createdAt: true,
              asset: {
                select: {
                  fileName: true,
                  project: {
                    select: {
                      name: true,
                      location: true,
                    },
                  },
                },
              },
            },
            skip: offset,
            take: BATCH_SIZE,
            orderBy: { createdAt: "desc" },
          }),
          QUERY_TIMEOUT
        );

        allDetections.push(...(detections as DetectionRecord[]));
        offset += BATCH_SIZE;
        hasMore = detections.length === BATCH_SIZE;
      }
    }

    // Fetch all manual annotations in batches
    if (includeManual) {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const annotations = await queryWithTimeout(
          prisma.manualAnnotation.findMany({
            where: {
              session: {
                asset: baseWhere.asset,
              },
              ...(classFilter.length > 0 ? { weedType: { in: classFilter } } : {}),
            },
            select: {
              id: true,
              weedType: true,
              confidence: true,
              centerLat: true,
              centerLon: true,
              coordinates: true,
              notes: true,
              createdAt: true,
              session: {
                select: {
                  asset: {
                    select: {
                      fileName: true,
                      project: {
                        select: {
                          name: true,
                          location: true,
                        },
                      },
                    },
                  },
                },
              },
            },
            skip: offset,
            take: BATCH_SIZE,
            orderBy: { createdAt: "desc" },
          }),
          QUERY_TIMEOUT
        );

        allAnnotations.push(...(annotations as AnnotationRecord[]));
        offset += BATCH_SIZE;
        hasMore = annotations.length === BATCH_SIZE;
      }
    }

    // Check if we have any data to export
    if (allDetections.length === 0 && allAnnotations.length === 0) {
      return new Response(
        JSON.stringify({ error: "No records found matching the selected filters" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Generate shapefile
    const { buffer, stats } = await generateShapefileExport(allDetections, allAnnotations);

    // Log export stats
    console.log(`Shapefile export: ${stats.exported} records exported, ${stats.skippedInvalidCoords} skipped`);

    // Return ZIP file
    const filename = `weed-detections-${new Date().toISOString().split("T")[0]}.zip`;

    return new Response(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": buffer.length.toString(),
        "X-Export-Total": stats.exported.toString(),
        "X-Export-Skipped": stats.skippedInvalidCoords.toString(),
      },
    });
  } catch (error) {
    console.error("Shapefile export error:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to generate shapefile",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
