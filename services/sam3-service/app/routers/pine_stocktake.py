"""Pine Stocktake v1 endpoints. Existing SAM3 routes remain unchanged."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from ..pine_stocktake import pine_sam3
from ..utils import fetch_image


router = APIRouter(prefix="/api/v1/pine-stocktake", tags=["pine-stocktake-v1"])
job_lock = asyncio.Lock()


class TargetImage(BaseModel):
    assetId: str
    imageUrl: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class Exemplar(BaseModel):
    id: str
    sourceAssetId: str
    sourceImageUrl: str
    sourceImageSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    exemplarSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    nativePolygon: list[tuple[float, float]] = Field(min_length=3)
    approved: bool


class PineJobRequest(BaseModel):
    stocktakeJobId: str
    stage: str
    idempotencyKey: str
    immutableManifestSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    targets: list[TargetImage]
    exemplars: list[Exemplar] = Field(min_length=3, max_length=3)


@router.get("/identity")
async def identity():
    try:
        return pine_sam3.identity()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/jobs")
async def run_job(request: PineJobRequest) -> dict[str, Any]:
    if request.stage != "detect_exemplars":
        raise HTTPException(status_code=400, detail="This backend accepts detect_exemplars only")
    targets, exemplars = [], []
    for target in request.targets:
        value = target.model_dump()
        value["_bytes"] = await fetch_image(target.imageUrl)
        if value["_bytes"] is None:
            raise HTTPException(status_code=400, detail=f"Could not fetch target {target.assetId}")
        targets.append(value)
    for exemplar in request.exemplars:
        value = exemplar.model_dump()
        value["_bytes"] = await fetch_image(exemplar.sourceImageUrl)
        if value["_bytes"] is None:
            raise HTTPException(status_code=400, detail=f"Could not fetch exemplar {exemplar.id}")
        exemplars.append(value)
    try:
        async with job_lock:
            result = await run_in_threadpool(pine_sam3.run, targets, exemplars)
        return {**result, "stocktakeJobId": request.stocktakeJobId, "idempotencyKey": request.idempotencyKey}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
