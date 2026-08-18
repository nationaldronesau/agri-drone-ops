import { expect, test } from '@playwright/test';

const hash = (character: string) => character.repeat(64);

const missionFiles = [
  { kind: 'IMAGE_LV', assetId: 'asset-lv', fileName: 'LV_001.JPG', sha256: hash('1'), cameraSerial: 'LV-SERIAL', crs: 'EPSG:32756' },
  { kind: 'IMAGE_RV', assetId: 'asset-rv', fileName: 'RV_001.JPG', sha256: hash('2'), cameraSerial: 'RV-SERIAL', crs: 'EPSG:32756' },
  { kind: 'CLC', assetId: 'asset-clc', fileName: 'flight.CLC', sha256: hash('3'), crs: 'EPSG:32756', metadata: { cameraSerials: ['LV-SERIAL', 'RV-SERIAL'] } },
  { kind: 'CLI', assetId: 'asset-cli', fileName: 'flight.CLI', sha256: hash('4'), crs: 'EPSG:32756', metadata: { quaternion: [1, 0, 0, 0], translation: [0, 0, 0] } },
  { kind: 'MRK', assetId: 'asset-mrk', fileName: 'flight.MRK', sha256: hash('5'), poseIdentity: 'flight-1', timebase: 'GPS', crs: 'EPSG:32756' },
  { kind: 'RPOS', assetId: 'asset-rpos', fileName: 'flight.RPOS', sha256: hash('6'), poseIdentity: 'flight-1', timebase: 'GPS', crs: 'EPSG:32756' },
  { kind: 'LIDAR_LAZ', assetId: 'asset-laz', fileName: 'flight.LAZ', sha256: hash('7'), crs: 'EPSG:32756' },
];

const candidate = (id: string, exemplarId: string, score: number) => ({
  id, candidateId: id, exemplarId, targetAssetId: 'asset-lv', targetImageSha256: hash('1'),
  nativePolygon: [[900, 700], [1180, 690], [1210, 980], [880, 990]], score,
  targetAsset: { id: 'asset-lv', fileName: 'LV_001.JPG', storageUrl: '/placeholder.svg', thumbnailUrl: '/placeholder.svg', imageWidth: 6144, imageHeight: 4096 },
});

const jobPayload = {
  job: {
    id: 'pine-job-1', status: 'REVIEW_REQUIRED', stage: 'REVIEW_CROWNS', progress: 62, failureReason: null,
    targetCrs: 'EPSG:32756', poseTimebase: 'GPS', modelRepository: 'facebook/sam3',
    modelRevision: '3c879f39826c281e95690f02c7821c4de09afae7', modelWeightSha256: '6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a',
    runnerCommit: '824cf071c7220f831cf3352111a43caddf8f25c8', runnerTreeSha256: '6c35112fe4c0b70d8018f3133ac562e3e9ca37f64cbaa970e48e624c17ab337d', immutableManifestSha256: hash('b'),
    project: { id: 'project-1', name: 'HQP validation mission', location: 'Queensland' },
    missionFiles: missionFiles.map((file, index) => ({ id: `file-${index}`, ...file, timebase: 'timebase' in file ? file.timebase : null })),
    exemplars: [1, 2, 3].map((number) => ({ id: `e${number}`, sourceAssetId: `external-${number}`, sourceImageSha256: hash(String(number + 3)), exemplarSha256: hash(String(number + 6)), approved: true, sourceAsset: { fileName: `external-${number}.JPG`, thumbnailUrl: '/placeholder.svg', storageUrl: '/placeholder.svg', imageWidth: 6144, imageHeight: 4096 } })),
    inferenceRuns: [1, 2, 3].flatMap((number) => ['asset-lv', 'asset-rv'].map((asset) => ({ id: `${number}-${asset}`, exemplarId: `e${number}`, targetAssetId: asset, status: 'completed', attemptCount: 1, failureReason: null }))),
    agreementGroups: [
      { id: 'group-3', agreementId: 'agreement-000001', agreementLevel: 3, scoresByExemplar: { e1: 0.94, e2: 0.91, e3: 0.89 }, nativePolygon: [[900, 700], [1180, 690], [1210, 980], [880, 990]], members: [candidate('c1', 'e1', 0.94), candidate('c2', 'e2', 0.91), candidate('c3', 'e3', 0.89)].map((item) => ({ candidateId: item.id, candidate: item })) },
      { id: 'group-1', agreementId: 'agreement-000002', agreementLevel: 1, scoresByExemplar: { e2: 0.72 }, nativePolygon: [[1500, 1200], [1700, 1200], [1700, 1400], [1500, 1400]], members: [{ candidateId: 'c4', candidate: candidate('c4', 'e2', 0.72) }] },
    ],
    acceptedCrowns: [{ id: 'accepted-1', crownId: 'LV-001-agreement-000001', agreementLevel: 3, edgeClipped: false, lidarAssociation: { status: 'matched', x: 500000.1, y: 7000000.1, apexX: 500000.11, apexY: 7000000.12, heightP99M: 0.92, heightMaxValidM: 0.98, missingReason: null } }],
    flatMapResult: { status: 'completed', approximate: true, projectedCrs: 'EPSG:32756', outputs: { previewPng: { url: '/placeholder.svg', sha256: hash('c') }, browserViewer: { url: '/flat-map-viewer.html', sha256: hash('d') }, previewBounds: [499990, 6999990, 500010, 7000010] } },
  },
  summary: { candidate: 4, accepted: 1, rejected: 2, unsure: 1, missedAdded: 1, missingLidar: 0 },
};

test('mission validation to review, rapid map, calibrated LiDAR and export', async ({ page }) => {
  const queuedStages: string[] = [];
  const reviewActions: string[] = [];
  const payload = structuredClone(jobPayload);
  const thirdExemplar = payload.job.exemplars[2];
  payload.job.exemplars = payload.job.exemplars.slice(0, 2);
  await page.route('**/api/projects', (route) => route.fulfill({ json: { projects: [{ id: 'project-1', name: 'HQP validation mission', location: 'Queensland' }] } }));
  await page.route('**/api/assets?*', (route) => route.fulfill({ json: { assets: [{ id: 'external-3', fileName: 'external-3.JPG', storageUrl: '/placeholder.svg', thumbnailUrl: '/placeholder.svg', imageWidth: 6144, imageHeight: 4096 }] } }));
  await page.route('**/api/pine-stocktake/jobs', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.files).toHaveLength(7);
      expect(body.poseTimebase).toBe('GPS');
      await route.fulfill({ status: 201, json: { jobId: 'pine-job-1' } });
    } else await route.fallback();
  });
  await page.route('**/api/pine-stocktake/jobs/pine-job-1', (route) => route.fulfill({ json: payload }));
  await page.route('**/api/pine-stocktake/jobs/pine-job-1/exemplars', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.sourceAssetId).toBe('external-3');
    expect(body.sourceImageSha256).toBe(hash('6'));
    expect(body.nativePolygon).toHaveLength(3);
    payload.job.exemplars.push(thirdExemplar);
    await route.fulfill({ status: 201, json: { exemplar: thirdExemplar } });
  });
  await page.route('**/api/pine-stocktake/jobs/pine-job-1/stage', async (route) => {
    const body = route.request().postDataJSON();
    queuedStages.push(body.stage);
    await route.fulfill({ status: 202, json: { queued: true } });
  });
  await page.route('**/api/pine-stocktake/jobs/pine-job-1/review', async (route) => {
    const body = route.request().postDataJSON();
    reviewActions.push(body.action);
    expect(body.nativePolygon.length).toBeGreaterThanOrEqual(3);
    await route.fulfill({ status: 201, json: { revision: { id: body.revisionId }, acceptedCrown: null } });
  });

  await page.goto('/orthomosaics/pine-stocktake/new');
  await page.getByLabel('Project').click();
  await page.getByRole('option', { name: /HQP validation mission/ }).click();
  await page.getByLabel('Mission manifest').setInputFiles({
    name: 'hqp-mission.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ latitude: -27.47, longitude: 153.03, poseTimebase: 'GPS', files: missionFiles })),
  });
  await expect(page.getByText('7 files ready for validation')).toBeVisible();
  await page.getByRole('button', { name: 'Create restartable job' }).click();
  await expect(page).toHaveURL(/\/orthomosaics\/pine-stocktake\/pine-job-1$/);

  await expect(page.getByRole('heading', { name: 'Pine Stocktake' })).toBeVisible();
  await expect(page.getByText('1. Upload and validate mission')).toBeVisible();
  await expect(page.getByText('4. Map, deduplicate and calculate heights')).toBeVisible();
  await expect(page.getByText(/facebook\/sam3@3c879f39826c/)).toBeVisible();
  await expect(page.getByText('Three approved crowns from images outside each target run separately. Target annotations cannot enter the prompt set.')).toBeVisible();
  await page.getByLabel('Source image').click();
  await page.getByRole('option', { name: 'external-3.JPG' }).click();
  await page.getByLabel('Image SHA-256').fill(hash('6'));
  const exemplarCanvas = page.getByRole('img', { name: 'Draw one complete external exemplar crown' });
  await exemplarCanvas.click({ position: { x: 120, y: 80 } });
  await exemplarCanvas.click({ position: { x: 210, y: 90 } });
  await exemplarCanvas.click({ position: { x: 170, y: 180 } });
  await page.getByRole('button', { name: 'Approve exemplar' }).click();
  await expect(page.getByText('Exemplar 3')).toBeVisible();
  await expect(page.getByText('agreement-000001')).toBeVisible();
  await expect(page.getByText('3/3').first()).toBeVisible();

  await page.getByRole('button', { name: /Detect/ }).click();
  await page.getByRole('button', { name: /Unsure/ }).click();
  await page.getByRole('button', { name: /Build rapid map/ }).click();
  await page.getByRole('button', { name: /Map LiDAR/ }).click();
  expect(queuedStages).toEqual(['detect_exemplars', 'build_flat_map', 'map_lidar']);
  expect(reviewActions).toEqual(['mark_unsure']);

  await expect(page.getByText('Flat Map positions are approximate.')).toBeVisible();
  await expect(page.getByText('LiDAR crown location')).toBeVisible();
  await expect(page.getByText('Highest valid crown point')).toBeVisible();
  await expect(page.getByText('0.92 m')).toBeVisible();
  await expect(page.getByRole('link', { name: 'CSV' })).toHaveAttribute('href', /format=csv/);
  await expect(page.getByRole('link', { name: 'GeoJSON' })).toHaveAttribute('href', /format=geojson/);
});
