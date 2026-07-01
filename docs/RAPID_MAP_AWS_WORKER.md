# Rapid Map AWS Worker

Rapid Map processing runs outside the Next.js web server. The web app creates a
`RapidMapRun`, enqueues `rapid-map-processing`, and the worker consumes that job.

The worker image uses
[`nationaldronesau/flat-map-runner`](https://github.com/nationaldronesau/flat-map-runner)
at commit `707ab72ffe90632f257fcdcaac9f357dba193b0b`. That engine is a
metadata-driven rapid map generator using rasterio/GDAL, pyproj, OpenCV, Pillow,
and numpy. It is not ODM, SfM, or full photogrammetry.

## Build

```bash
docker build -f Dockerfile.rapid-map-worker -t agridrone-rapid-map-worker .
```

## Runtime

```bash
npm run worker:rapid-map
```

Required production services:

- RDS/MySQL via `DATABASE_URL`
- Redis/ElastiCache via `REDIS_URL`
- S3 via `AWS_REGION` and `AWS_S3_BUCKET`
- IAM access for S3 read/write

Rapid Map runner configuration:

- `RAPID_MAP_RUNNER_COMMAND`: executable path for the map engine wrapper
- `RAPID_MAP_RUNNER_ARGS`: optional JSON string array of extra args
- `RAPID_MAP_RUNNER_TIMEOUT_MS`: optional timeout, default 6 hours
- `RAPID_MAP_WORKER_CONCURRENCY`: optional concurrency, default 1
- `RAPID_MAP_KEEP_WORKDIR=1`: keep temp job files for debugging

The default worker image sets:

```bash
RAPID_MAP_RUNNER_COMMAND=/opt/flatmap-venv/bin/python
RAPID_MAP_RUNNER_ARGS='["/app/scripts/run-rapid-map-flatmap.py"]'
FLAT_MAP_RUNNER_DIR=/opt/flat-map-runner
FLAT_MAP_PYTHON=/opt/flatmap-venv/bin/python
```

## Source Folder Contract

For the first production path, the source must contain imagery and a
`metadata.csv` compatible with `flat-map-runner`.

For an S3 source prefix:

```text
s3://agridrone-ops-production/production/{projectId}/raw-images/{flightSession}/
  metadata.csv
  DJI_0001.JPG
  DJI_0002.JPG
```

The adapter also accepts:

```text
...
  images/
    DJI_0001.JPG
    DJI_0002.JPG
  metadata.csv
```

`metadata.csv` minimum columns:

```text
filename,lat,lon,RelativeAltitude,FlightYawDegree
```

Recommended columns:

```text
filename,lat,lon,AbsoluteAltitude,RelativeAltitude,FlightYawDegree,GimbalPitchDegree,GimbalRollDegree,ImageWidth,ImageLength
```

## Runner Contract

The worker calls:

```bash
$RAPID_MAP_RUNNER_COMMAND --job /tmp/.../rapid-map-job.json --output /tmp/.../output
```

The runner must write:

```text
/tmp/.../output/manifest.json
```

Minimum manifest shape:

```json
{
  "version": 1,
  "summary": {
    "sourceImageCount": 999,
    "renderedImageCount": 999,
    "excludedImageCount": 0,
    "estimatedErrorMeters": 1.5
  },
  "artifacts": [
    {
      "path": "rapid-map.tif",
      "role": "geotiff",
      "contentType": "image/tiff"
    },
    {
      "path": "preview.png",
      "role": "preview",
      "contentType": "image/png"
    }
  ],
  "orthomosaic": {
    "name": "Rapid Map",
    "bounds": {
      "type": "Polygon",
      "coordinates": []
    },
    "centerLat": -27.4698,
    "centerLon": 153.0251,
    "resolutionCmPerPixel": 30,
    "imageCount": 999
  }
}
```

The worker uploads listed artifacts to S3 under the run output prefix, creates
an `Orthomosaic` when the manifest includes the required map metadata, and marks
the `RapidMapRun` as `COMPLETED`.

If `RAPID_MAP_RUNNER_COMMAND` is not configured, jobs fail clearly with a
configuration error instead of silently sitting in the queue.
